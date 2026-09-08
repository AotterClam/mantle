import { describe, expect, it } from "vitest";
import type { SiteConfig } from "@aotter/mantle-spec";
import { DatabaseEntryRepository } from "../../mantle-runtime/src/infrastructure/persistence/DatabaseEntryRepository.js";
import { ComposeLlmsTxtUseCase } from "../src/usecase/ComposeLlmsTxtUseCase.js";
import { ComposeSitemapUseCase } from "../src/usecase/ComposeSitemapUseCase.js";
import { createPublicPathResolver } from "../src/service/PublicPathResolver.js";
import { InMemoryDatabase } from "../../mantle-runtime/test/fakes/database.js";

const site: SiteConfig = {
  title: "Blog",
  description: "Reference starter",
  origin: "https://example.com",
  locales: ["en", "zh-TW"],
  canonicalLocale: "en",
  brand: "Blog",
};
const paths = createPublicPathResolver({
  collectionRoutes: {
    posts: { segment: "posts" },
    guides: { segment: "guides" },
  },
});

function seedPublished(
  db: InMemoryDatabase,
  args: {
    id: string;
    collection: string;
    locale?: string;
    data: Record<string, unknown>;
    updatedAt?: number;
  },
): void {
  db.entries.set(args.id, {
    id: args.id,
    collection: args.collection,
    status: "published",
    version: 1,
    data: JSON.stringify({ ...args.data, ...(args.locale ? { locale: args.locale } : {}) }),
    author_id: null,
    created_at: 1,
    updated_at: args.updatedAt ?? 2,
  });
}

describe("ComposeLlmsTxtUseCase", () => {
  it("groups published entries by collection at the requested locale", async () => {
    const db = new InMemoryDatabase();
    seedPublished(db, {
      id: "p1",
      collection: "posts",
      locale: "en",
      data: { slug: "hello", title: "Hello", content: "Body" },
    });
    seedPublished(db, {
      id: "p2",
      collection: "posts",
      locale: "zh-TW",
      data: { slug: "ni-hao", title: "你好", content: "正文" },
    });
    const out = await new ComposeLlmsTxtUseCase(new DatabaseEntryRepository(db), paths).execute({ site, locale: "en" });
    expect(out?.body).toContain("[Hello]");
    expect(out?.body).not.toContain("[你好]");
  });

  it("locale: null returns only non-localized entries (matches publish semantics)", async () => {
    const db = new InMemoryDatabase();
    seedPublished(db, {
      id: "p1",
      collection: "posts",
      locale: "en",
      data: { slug: "hello", title: "Hello", content: "Body" },
    });
    seedPublished(db, {
      id: "g1",
      collection: "guides",
      data: { slug: "intro", title: "Intro", content: "Welcome" },
    });
    const out = await new ComposeLlmsTxtUseCase(new DatabaseEntryRepository(db), paths).execute({ site, locale: null });
    expect(out?.body).toContain("[Intro]");
    expect(out?.body).not.toContain("[Hello]");
  });
});

describe("ComposeSitemapUseCase", () => {
  it("uses entryPublicPath by default", async () => {
    const db = new InMemoryDatabase();
    seedPublished(db, {
      id: "p1",
      collection: "posts",
      locale: "en",
      data: { slug: "hello" },
    });
    const out = await new ComposeSitemapUseCase(new DatabaseEntryRepository(db)).execute({ site });
    expect(out?.body).toMatch(/<\?xml version="1\.0"/);
    expect(out?.body).toContain("<urlset");
    expect(out?.body).toContain("<loc>https://example.com/en/posts/hello</loc>");
    expect(out?.body).toContain("<lastmod>");
  });

  it("custom pathFor remaps storage shape → public route shape", async () => {
    const db = new InMemoryDatabase();
    seedPublished(db, {
      id: "p1",
      collection: "post-translations",
      locale: "en",
      data: { slug: "hello" },
    });
    seedPublished(db, {
      id: "p2",
      collection: "post-translations",
      locale: "zh-TW",
      data: { slug: "hello" },
    });
    const out = await new ComposeSitemapUseCase(new DatabaseEntryRepository(db)).execute({
      site,
      pathFor: (e) => {
        const slug = (e.data as { slug?: string }).slug;
        const locale = e.locale?.toLowerCase();
        if (e.collection === "post-translations" && slug && locale) {
          return `/${locale}/posts/${slug}`;
        }
        return null;
      },
    });
    expect(out?.body).toContain("<loc>https://example.com/en/posts/hello</loc>");
    expect(out?.body).toContain("<loc>https://example.com/zh-tw/posts/hello</loc>");
  });

  it("pathFor returning null skips the entry", async () => {
    const db = new InMemoryDatabase();
    seedPublished(db, {
      id: "p1",
      collection: "posts",
      locale: "en",
      data: { slug: "hello" },
    });
    seedPublished(db, {
      id: "draft",
      collection: "internal",
      data: { slug: "skip" },
    });
    const out = await new ComposeSitemapUseCase(new DatabaseEntryRepository(db)).execute({
      site,
      pathFor: (e) => (e.collection === "internal" ? null : `/${e.collection}/${(e.data as { slug?: string }).slug}`),
    });
    expect(out?.body).toContain("/posts/hello");
    expect(out?.body).not.toContain("/internal/");
  });

  it("maxUrls caps the SQL read (not just the JS array)", async () => {
    const db = new InMemoryDatabase();
    for (let i = 0; i < 8; i++) {
      seedPublished(db, {
        id: `p${i}`,
        collection: "posts",
        locale: "en",
        data: { slug: `s${i}` },
      });
    }
    const out = await new ComposeSitemapUseCase(new DatabaseEntryRepository(db)).execute({ site, maxUrls: 3 });
    const urlCount = (out.body.match(/<url>/g) ?? []).length;
    expect(urlCount).toBe(3);
  });

  it("rejects custom sitemap expansion beyond protocol limits instead of dropping URLs", async () => {
    const db = new InMemoryDatabase();
    seedPublished(db, { id: "p1", collection: "posts", data: { slug: "hello" } });
    const sitemap = new ComposeSitemapUseCase(new DatabaseEntryRepository(db));
    await expect(sitemap.execute({ site, pathFor: () => Array.from({ length: 50_001 }, (_, i) => `/item-${i}`) }))
      .rejects.toThrow("50,000 URLs");
    await expect(sitemap.index({ site }, () => "/" + "x".repeat(50 * 1024 * 1024)))
      .rejects.toThrow("50 MiB");
  });

  it("XML-escapes ampersands in origins / paths", async () => {
    const db = new InMemoryDatabase();
    seedPublished(db, {
      id: "p1",
      collection: "posts",
      locale: "en",
      data: { slug: "a-and-b" },
    });
    const out = await new ComposeSitemapUseCase(new DatabaseEntryRepository(db)).execute({
      site: { ...site, origin: "https://x.com?a=1&b=2" },
    });
    expect(out?.body).toContain("&amp;");
    expect(out?.body).not.toMatch(/&[^a-z#]/);
  });
});
