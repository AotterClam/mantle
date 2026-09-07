import {
  assertSiteDefaultsCanonical,
  type MediaPurposePolicy,
  type SiteConfig,
  type SiteDefaults,
  type SiteIcon,
} from "@aotter/mantle-spec";
import type {
  SiteConfigRepository,
  UpdateEditableSiteConfigArgs,
} from "@aotter/mantle-runtime";

const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_AGE_MS = 3_600_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_PUT_BACKOFF_MS = 60_000;
const SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export type McpCatalogSiteConfig = Pick<
  SiteConfig,
  "origin" | "brand" | "description" | "icons" | "media"
>;

export interface McpCatalogKvBinding {
  readonly namespace: KVNamespace;
  /** Stable deployment-owned scope. Never derive this from a request. */
  readonly scope: string;
}

export interface McpCatalogSiteConfigReader {
  /** Resolve caller-independent catalog data after the transport auth gate. */
  loadCatalogSite(runtime: object): Promise<McpCatalogSiteConfig>;
}

interface CatalogSnapshotV1 {
  readonly version: 1;
  readonly scope: string;
  readonly observedAt: number;
  readonly repairAfter: number;
  readonly contentHash: string;
  readonly site: McpCatalogSiteConfig;
}

interface InFlightCatalogLoad {
  readonly generation: number;
  readonly promise: Promise<McpCatalogSiteConfig>;
}

/**
 * Cloudflare-owned write-through decorator for MCP catalog configuration.
 * The delegate remains canonical: ordinary repository reads always hit D1,
 * while only the caller-independent MCP projection is stored in KV.
 */
export class KvSiteConfigRepository
  implements SiteConfigRepository, McpCatalogSiteConfigReader {
  readonly key: string;
  private readonly inFlight = new WeakMap<object, InFlightCatalogLoad>();
  private generation = 0;
  private lastKnownSnapshot: CatalogSnapshotV1 | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private putFailureCount = 0;
  private putBackoffUntil = 0;
  private readonly diagnosticCounts = new Map<string, number>();

  constructor(
    private readonly canonical: SiteConfigRepository,
    private readonly binding: McpCatalogKvBinding,
  ) {
    if (!SCOPE_PATTERN.test(binding.scope)) {
      throw new Error(
        "Mantle MCP catalog KV scope must contain 1-64 ASCII letters, digits, '_' or '-'.",
      );
    }
    this.key = `mantle:site-config:v1:${binding.scope}:mcp`;
  }

  load(): Promise<SiteConfig> {
    return this.canonical.load();
  }

  readLocales(): Promise<readonly string[]> {
    return this.canonical.readLocales();
  }

  readMediaPurposes(): Promise<readonly MediaPurposePolicy[]> {
    return this.canonical.readMediaPurposes();
  }

  async seed(defaults: SiteDefaults | undefined): Promise<void> {
    await this.exclusive(async () => {
      await this.canonical.seed(defaults);
      this.generation += 1;
      await this.publishAfterCommittedWrite("seed");
    });
  }

  async updateEditable(values: UpdateEditableSiteConfigArgs): Promise<void> {
    if (!this.canonical.updateEditable) {
      throw new Error("SiteConfigRepository.updateEditable is unavailable");
    }
    await this.exclusive(async () => {
      await this.canonical.updateEditable!(values);
      this.generation += 1;
      await this.publishAfterCommittedWrite("update");
    });
  }

  loadCatalogSite(runtime: object): Promise<McpCatalogSiteConfig> {
    const generation = this.generation;
    const existing = this.inFlight.get(runtime);
    if (existing?.generation === generation) return existing.promise;
    const pending = this.readCatalogSite(generation).finally(() => {
      if (this.inFlight.get(runtime)?.promise === pending) this.inFlight.delete(runtime);
    });
    this.inFlight.set(runtime, { generation, promise: pending });
    return pending;
  }

  private async readCatalogSite(generation: number): Promise<McpCatalogSiteConfig> {
    let raw: string | null = null;
    try {
      raw = await this.binding.namespace.get(this.key, "text");
    } catch (error) {
      this.diagnostic("get-failed", error);
    }
    if (raw !== null) {
      const snapshot = await parseSnapshot(raw, this.binding.scope, Date.now());
      if (snapshot && generation === this.generation) {
        this.lastKnownSnapshot = snapshot;
        return snapshot.site;
      }
    }

    return this.repairCatalogSite();
  }

  private repairCatalogSite(): Promise<McpCatalogSiteConfig> {
    // Serialize miss fill with local setting mutations. Every publication
    // reloads canonical state inside the same critical section, so an older
    // local miss cannot overwrite a newer local write-through publication.
    return this.exclusive(async () => {
      const snapshot = await this.loadCanonicalSnapshot();
      await this.putSnapshot(snapshot, true);
      return snapshot.site;
    });
  }

  private async publishAfterCommittedWrite(reason: "seed" | "update"): Promise<void> {
    try {
      const snapshot = await this.loadCanonicalSnapshot();
      await this.putSnapshot(snapshot);
    } catch (error) {
      // D1 already committed. Derived-cache repair must never turn a saved
      // setting into a misleading failure or suppress the public-cache purge.
      this.diagnostic(`${reason}-publication-failed`, error);
    }
  }

  private async loadCanonicalSnapshot(): Promise<CatalogSnapshotV1> {
    // Anchor freshness before the canonical read. A delayed load cannot gain
    // a fresh lifetime merely because serialization or KV put completed later.
    const observedAt = Date.now();
    const site = normalizeCatalogSite(projectCatalogSite(await this.canonical.load()));
    return {
      version: SNAPSHOT_VERSION,
      scope: this.binding.scope,
      observedAt,
      repairAfter: observedAt + MAX_SNAPSHOT_AGE_MS,
      contentHash: await contentHash(site),
      site,
    };
  }

  private async putSnapshot(snapshot: CatalogSnapshotV1, force = false): Promise<void> {
    const now = Date.now();
    if (snapshot.repairAfter <= now || now < this.putBackoffUntil) return;
    if (
      !force
      && this.lastKnownSnapshot?.contentHash === snapshot.contentHash
      && isSnapshotFresh(this.lastKnownSnapshot, now)
    ) return;
    const value = JSON.stringify(snapshot);
    const bytes = utf8Bytes(value);
    if (bytes > MAX_ENVELOPE_BYTES) {
      this.diagnostic("oversized", { bytes, limit: MAX_ENVELOPE_BYTES });
      return;
    }
    try {
      await this.binding.namespace.put(this.key, value, {
        expiration: Math.ceil(snapshot.repairAfter / 1000),
      });
      this.lastKnownSnapshot = snapshot;
      this.putFailureCount = 0;
      this.putBackoffUntil = 0;
    } catch (error) {
      this.putFailureCount += 1;
      this.putBackoffUntil = now + Math.min(
        MAX_PUT_BACKOFF_MS,
        1_000 * (2 ** Math.min(this.putFailureCount - 1, 6)),
      );
      this.diagnostic("put-failed", error);
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private diagnostic(kind: string, detail: unknown): void {
    const count = (this.diagnosticCounts.get(kind) ?? 0) + 1;
    this.diagnosticCounts.set(kind, count);
    // Bound repeated outage logs to the first occurrence and powers of two.
    if (count !== 1 && (count & (count - 1)) !== 0) return;
    const safeDetail = isRecord(detail) && typeof detail["bytes"] === "number"
      ? { bytes: detail["bytes"], limit: detail["limit"] }
      : detail instanceof Error
        ? { name: detail.name }
        : undefined;
    console.warn("[mantle] MCP catalog KV diagnostic", {
      kind,
      count,
      ...(safeDetail ? { detail: safeDetail } : {}),
    });
  }
}

export function projectMcpCatalogSiteConfig(site: SiteConfig): McpCatalogSiteConfig {
  return normalizeCatalogSite(projectCatalogSite(site));
}

function projectCatalogSite(site: SiteConfig): McpCatalogSiteConfig {
  return {
    origin: site.origin,
    brand: site.brand,
    description: site.description,
    icons: site.icons,
    media: site.media,
  };
}

function normalizeCatalogSite(site: McpCatalogSiteConfig): McpCatalogSiteConfig {
  return {
    origin: site.origin,
    brand: site.brand,
    description: site.description,
    icons: site.icons.map(normalizeIcon),
    media: {
      purposes: site.media.purposes.map((purpose) => ({
        name: purpose.name,
        required: [...purpose.required],
        maxBytes: Object.fromEntries(
          Object.entries(purpose.maxBytes).sort(([left], [right]) => left.localeCompare(right)),
        ),
      })),
    },
  };
}

function normalizeIcon(icon: SiteIcon): SiteIcon {
  return {
    src: icon.src,
    ...(icon.mimeType ? { mimeType: icon.mimeType } : {}),
    ...(icon.sizes ? { sizes: [...icon.sizes] } : {}),
    ...(icon.theme ? { theme: icon.theme } : {}),
  };
}

async function parseSnapshot(
  raw: string,
  scope: string,
  now: number,
): Promise<CatalogSnapshotV1 | null> {
  if (utf8Bytes(raw) > MAX_ENVELOPE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "scope",
    "observedAt",
    "repairAfter",
    "contentHash",
    "site",
  ])) return null;
  if (
    value["version"] !== SNAPSHOT_VERSION
    || value["scope"] !== scope
    || !isEpoch(value["observedAt"])
    || !isEpoch(value["repairAfter"])
    || typeof value["contentHash"] !== "string"
    || !/^[a-f0-9]{64}$/u.test(value["contentHash"])
  ) return null;
  const observedAt = value["observedAt"];
  const repairAfter = value["repairAfter"];
  if (!isSnapshotFresh({ observedAt, repairAfter }, now)) return null;
  const site = parseCatalogSite(value["site"]);
  if (!site) return null;
  const normalized = normalizeCatalogSite(site);
  if (await contentHash(normalized) !== value["contentHash"]) return null;
  return {
    version: SNAPSHOT_VERSION,
    scope,
    observedAt,
    repairAfter,
    contentHash: value["contentHash"],
    site: normalized,
  };
}

function isSnapshotFresh(
  value: Pick<CatalogSnapshotV1, "observedAt" | "repairAfter">,
  now: number,
): boolean {
  return value.observedAt <= now + MAX_FUTURE_SKEW_MS
    && value.repairAfter > value.observedAt
    && value.repairAfter - value.observedAt <= MAX_SNAPSHOT_AGE_MS
    && value.repairAfter > now;
}

function parseCatalogSite(value: unknown): McpCatalogSiteConfig | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "origin",
    "brand",
    "description",
    "icons",
    "media",
  ])) return null;
  if (
    typeof value["origin"] !== "string"
    || typeof value["brand"] !== "string"
    || typeof value["description"] !== "string"
    || !Array.isArray(value["icons"])
    || !isRecord(value["media"])
    || !hasExactKeys(value["media"], ["purposes"])
    || !Array.isArray(value["media"]["purposes"])
  ) return null;
  const icons = value["icons"].map(parseIcon);
  const purposes = value["media"]["purposes"].map(parsePurpose);
  if (icons.some((icon) => icon === null) || purposes.some((purpose) => purpose === null)) {
    return null;
  }
  const site: McpCatalogSiteConfig = {
    origin: value["origin"],
    brand: value["brand"],
    description: value["description"],
    icons: icons as SiteIcon[],
    media: { purposes: purposes as MediaPurposePolicy[] },
  };
  try {
    assertSiteDefaultsCanonical({
      origin: site.origin,
      brand: site.brand,
      description: site.description,
      icons: site.icons,
      media: site.media,
    });
    return site;
  } catch {
    return null;
  }
}

function parseIcon(value: unknown): SiteIcon | null {
  if (!isRecord(value) || !hasAllowedKeys(value, ["src", "mimeType", "sizes", "theme"])) {
    return null;
  }
  if (
    typeof value["src"] !== "string"
    || (value["mimeType"] !== undefined && typeof value["mimeType"] !== "string")
    || (value["theme"] !== undefined && typeof value["theme"] !== "string")
    || (value["sizes"] !== undefined && (
      !Array.isArray(value["sizes"])
      || !value["sizes"].every((size) => typeof size === "string")
    ))
  ) return null;
  return value as unknown as SiteIcon;
}

function parsePurpose(value: unknown): MediaPurposePolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "required", "maxBytes"])) return null;
  if (
    typeof value["name"] !== "string"
    || !Array.isArray(value["required"])
    || !value["required"].every((item) => typeof item === "string")
    || !isRecord(value["maxBytes"])
    || !Object.values(value["maxBytes"]).every((bytes) => (
      typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0
    ))
  ) return null;
  return value as unknown as MediaPurposePolicy;
}

async function contentHash(site: McpCatalogSiteConfig): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(site)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasAllowedKeys(value, keys);
}

function hasAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
