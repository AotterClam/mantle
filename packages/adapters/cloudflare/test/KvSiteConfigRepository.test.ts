import { siteConfigFromDefaults, type SiteConfigRepository } from "@aotter/mantle-runtime";
import type {
  SiteConfig,
  SiteDefaults,
} from "@aotter/mantle-spec";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KvSiteConfigRepository,
  type McpCatalogSiteConfig,
} from "../src/bindings/KvSiteConfigRepository.js";
import { createMantleRuntimeRef } from "../src/mount/bootRuntimeOnce.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { compileTestPlan } from "./compileTestPlan.js";
import { StubAssetServer, stubAuth } from "./fakes/runtime-bindings.js";

const SCOPE = "production";
const KEY = `mantle:site-config:v1:${SCOPE}:mcp`;

describe("KvSiteConfigRepository", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes the caller-independent MCP projection after canonical writes", async () => {
    const events: string[] = [];
    const canonical = new FakeSiteConfigRepository(events);
    const kv = new FakeKvNamespace(events);
    const repository = createRepository(canonical, kv);

    await repository.seed(siteDefaults({
      brand: "Before",
      title: "Private operator title",
      locales: ["zh-TW", "en"],
      ga4MeasurementId: "G-PRIVATE",
    }));

    expect(events).toEqual(["canonical:seed", "kv:put"]);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]?.key).toBe(KEY);
    const seeded = parseEnvelope(kv.puts[0]!.value);
    expect(seeded.site).toEqual({
      origin: "https://example.test",
      brand: "Before",
      description: "Site description",
      icons: [{ src: "/icon.png", mimeType: "image/png", sizes: ["64x64"] }],
      media: {
        purposes: [{
          name: "post-cover",
          required: ["image/webp", "image/jpeg"],
          maxBytes: { "image/jpeg": 600_000, "image/webp": 400_000 },
        }],
      },
    });
    expect(seeded.site).not.toHaveProperty("title");
    expect(seeded.site).not.toHaveProperty("locales");
    expect(seeded.site).not.toHaveProperty("ga4MeasurementId");

    events.length = 0;
    await repository.updateEditable({ brand: "After", description: "Updated" });

    expect(events).toEqual(["canonical:update", "kv:put"]);
    expect(parseEnvelope(kv.puts[1]!.value).site).toMatchObject({
      brand: "After",
      description: "Updated",
    });

    await repository.updateEditable({ title: "Not in the MCP projection" });
    expect(kv.puts).toHaveLength(2);

  });

  it("keeps a committed canonical update successful when derived KV publication fails", async () => {
    const canonical = new FakeSiteConfigRepository();
    const kv = new FakeKvNamespace();
    kv.putError = new Error("KV unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repository = createRepository(canonical, kv);

    await expect(repository.updateEditable({ brand: "Committed" })).resolves.toBeUndefined();

    expect((await canonical.load()).brand).toBe("Committed");
    expect(warn).toHaveBeenCalledWith(
      "[mantle] MCP catalog KV diagnostic",
      expect.objectContaining({ kind: "put-failed", count: 1 }),
    );
  });

  it("reads a valid snapshot without D1 and repairs an invalid snapshot from D1", async () => {
    const kv = new FakeKvNamespace();
    const writerCanonical = new FakeSiteConfigRepository();
    await createRepository(writerCanonical, kv).seed(siteDefaults({ brand: "From KV" }));

    const readerCanonical = new FakeSiteConfigRepository();
    readerCanonical.loadError = new Error("D1 should not be read");
    const reader = createRepository(readerCanonical, kv);
    await expect(reader.loadCatalogSite({})).resolves.toMatchObject({ brand: "From KV" });
    expect(readerCanonical.loadCalls).toBe(0);

    kv.values.set(KEY, "not-json");
    readerCanonical.loadError = undefined;
    readerCanonical.site = siteConfigFromDefaults(siteDefaults({ brand: "Repaired from D1" }));
    const repairingReader = createRepository(readerCanonical, kv);
    const repaired = await repairingReader.loadCatalogSite({});

    expect(repaired.brand).toBe("Repaired from D1");
    expect(readerCanonical.loadCalls).toBe(1);
    expect(parseEnvelope(kv.values.get(KEY)!).site.brand).toBe("Repaired from D1");
  });

  it("coalesces a cold load per runtime and clears a rejected load for retry", async () => {
    const canonical = new FakeSiteConfigRepository();
    const kv = new FakeKvNamespace();
    const deferred = deferredValue<string | null>();
    kv.getHook = () => deferred.promise;
    const repository = createRepository(canonical, kv);
    const runtime = {};

    const first = repository.loadCatalogSite(runtime);
    const second = repository.loadCatalogSite(runtime);
    expect(first).toBe(second);
    expect(kv.getCalls).toBe(1);
    deferred.resolve(null);
    await expect(first).resolves.toMatchObject({ brand: "Mantle" });
    expect(canonical.loadCalls).toBe(1);

    const failingCanonical = new FakeSiteConfigRepository();
    failingCanonical.loadError = new Error("temporary D1 failure");
    const retryKv = new FakeKvNamespace();
    const retrying = createRepository(failingCanonical, retryKv);
    await expect(retrying.loadCatalogSite(runtime)).rejects.toThrow("temporary D1 failure");
    failingCanonical.loadError = undefined;
    await expect(retrying.loadCatalogSite(runtime)).resolves.toMatchObject({ brand: "Mantle" });
    expect(retryKv.getCalls).toBe(2);
  });

  it("makes an obsolete local read repair from canonical after a newer write", async () => {
    const staleKv = new FakeKvNamespace();
    await createRepository(new FakeSiteConfigRepository(), staleKv)
      .seed(siteDefaults({ brand: "Stale" }));
    const staleValue = staleKv.values.get(KEY)!;

    const canonical = new FakeSiteConfigRepository();
    canonical.site = siteConfigFromDefaults(siteDefaults({ brand: "Stale" }));
    const kv = new FakeKvNamespace();
    const delayedGet = deferredValue<string | null>();
    kv.getHook = () => delayedGet.promise;
    const repository = createRepository(canonical, kv);

    const oldRead = repository.loadCatalogSite({});
    await repository.updateEditable({ brand: "Current" });
    delayedGet.resolve(staleValue);

    await expect(oldRead).resolves.toMatchObject({ brand: "Current" });
    expect(parseEnvelope(kv.puts.at(-1)!.value).site.brand).toBe("Current");
  });

  it("rejects request-derived or otherwise unstable scopes", () => {
    expect(() => new KvSiteConfigRepository(
      new FakeSiteConfigRepository(),
      { namespace: new FakeKvNamespace() as unknown as KVNamespace, scope: "tenant/site" },
    )).toThrow("scope");
  });

  it("wires runtime preparation and Admin settings updates through MANTLE_KV", async () => {
    const kv = new FakeKvNamespace();
    const ref = createMantleRuntimeRef({
      plan: compileTestPlan([]),
      siteDefaults: siteDefaults({ brand: "Prepared" }),
      bindings: {
        db: new InMemoryDatabase(),
        adminAssets: new StubAssetServer(),
        mcpCatalogKv: {
          namespace: kv as unknown as KVNamespace,
          scope: SCOPE,
        },
      },
      auth: stubAuth,
    });

    const runtime = await ref.get();
    expect(parseEnvelope(kv.puts.at(-1)!.value).site.brand).toBe("Prepared");

    await runtime.updateSiteSettings.execute({ brand: "Operator updated" });

    expect(parseEnvelope(kv.puts.at(-1)!.value).site.brand).toBe("Operator updated");
  });

  it("repairs empty KV on first catalog read when preparation skips a current fingerprint", async () => {
    const db = new InMemoryDatabase();
    const plan = compileTestPlan([]);
    const defaults = siteDefaults({ brand: "Already prepared" });
    await createMantleRuntimeRef({
      plan,
      siteDefaults: defaults,
      bindings: { db, adminAssets: new StubAssetServer() },
      auth: stubAuth,
    }).get();

    const kv = new FakeKvNamespace();
    const ref = createMantleRuntimeRef({
      plan,
      siteDefaults: defaults,
      bindings: {
        db,
        adminAssets: new StubAssetServer(),
        mcpCatalogKv: { namespace: kv as unknown as KVNamespace, scope: SCOPE },
      },
      auth: stubAuth,
    });
    const runtime = await ref.get();

    expect(kv.puts).toHaveLength(0);
    await expect(ref.mcpCatalogSiteConfig?.loadCatalogSite(runtime))
      .resolves.toMatchObject({ brand: "Already prepared" });
    expect(kv.puts).toHaveLength(1);
  });
});

function createRepository(
  canonical: SiteConfigRepository,
  kv: FakeKvNamespace,
): KvSiteConfigRepository {
  return new KvSiteConfigRepository(canonical, {
    namespace: kv as unknown as KVNamespace,
    scope: SCOPE,
  });
}

function siteDefaults(overrides: Partial<SiteDefaults> = {}): SiteDefaults {
  return {
    origin: "https://example.test",
    brand: "Mantle",
    title: "Mantle title",
    description: "Site description",
    locales: ["en"],
    icons: [{ src: "/icon.png", mimeType: "image/png", sizes: ["64x64"] }],
    media: {
      purposes: [{
        name: "post-cover",
        required: ["image/webp", "image/jpeg"],
        maxBytes: { "image/webp": 400_000, "image/jpeg": 600_000 },
      }],
    },
    ...overrides,
  };
}

class FakeSiteConfigRepository implements SiteConfigRepository {
  site = siteConfigFromDefaults(siteDefaults());
  loadCalls = 0;
  loadError: Error | undefined;

  constructor(private readonly events: string[] = []) {}

  async seed(defaults: SiteDefaults | undefined): Promise<void> {
    this.events.push("canonical:seed");
    if (defaults) this.site = siteConfigFromDefaults(defaults);
  }

  async updateEditable(values: Parameters<NonNullable<SiteConfigRepository["updateEditable"]>>[0]): Promise<void> {
    this.events.push("canonical:update");
    this.site = { ...this.site, ...values };
  }

  async load(): Promise<SiteConfig> {
    this.loadCalls += 1;
    if (this.loadError) throw this.loadError;
    return this.site;
  }

  async readLocales(): Promise<readonly string[]> {
    return this.site.locales;
  }

  async readMediaPurposes() {
    return this.site.media.purposes;
  }
}

class FakeKvNamespace {
  readonly values = new Map<string, string>();
  readonly puts: Array<{
    key: string;
    value: string;
    options: { expiration?: number };
  }> = [];
  putError: Error | undefined;
  getHook: (() => Promise<string | null>) | undefined;
  getCalls = 0;

  constructor(private readonly events: string[] = []) {}

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    if (this.getHook) return this.getHook();
    return this.values.get(key) ?? null;
  }

  async put(
    key: string,
    value: string,
    options: { expiration?: number } = {},
  ): Promise<void> {
    this.events.push("kv:put");
    if (this.putError) throw this.putError;
    this.values.set(key, value);
    this.puts.push({ key, value, options });
  }
}

function parseEnvelope(value: string): { readonly site: McpCatalogSiteConfig } {
  return JSON.parse(value) as { readonly site: McpCatalogSiteConfig };
}

function deferredValue<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
