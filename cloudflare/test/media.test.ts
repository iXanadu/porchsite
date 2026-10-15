// Images (SPEC S7): copied in at save, described, served from the site itself.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import { ApiError } from "../src/errors";
import * as media from "../src/media";
import * as site from "../src/site";

const db = (env as unknown as { DB: D1Database }).DB;
const who = "assistant:test";

// A JPEG header is enough for the type check; the rest is filler.
const jpeg = (size: number, fill = 7) => {
  const b = new Uint8Array(size).fill(fill);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};
const serving = (bytes: Uint8Array, type = "image/jpeg"): media.Fetcher => async () =>
  new Response(bytes, { headers: { "content-type": type, "content-length": String(bytes.byteLength) } });

async function refused(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("images", () => {
  it("batches forty local pictures across create and update", async () => {
    const paths = await Promise.all(Array.from({ length: 40 }, (_, i) => media.store(db, jpeg(100, i + 1), "image/jpeg", "fixture")));
    const body = paths.map((path, i) => `![Picture ${i}](${path})`).join("\n\n");
    let reads = 0;
    const counted = new Proxy(db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.startsWith("SELECT name FROM media WHERE name")) reads++;
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const item = await content.createItem(counted, who, "entry", { title: "Pictures", date: "2026-10-15", body }, undefined);
    expect(reads).toBe(1);
    expect(item.data.body).toBe(body);
    reads = 0;
    const changed = await content.updateItem(counted, who, item.id, item.version, { body: body + `\n![Repeated](${paths[0]})` });
    expect(reads).toBe(1);
    expect(changed.data.body).toBe(body + `\n![Repeated](${paths[0]})`);
  });

  it("keeps error order and accepts a local image created by an earlier hotlink", async () => {
    const bytes = jpeg(123, 61);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const path = `/media/${Array.from(hash.slice(0, 16), b => b.toString(16).padStart(2, "0")).join("")}.jpg`;
    const out = await media.localize(db, "entry", { cover: "https://example.com/new.jpg", cover_alt: "Cover", body: `![Again](${path})` }, serving(bytes));
    expect(out.cover).toBe(path);
    expect(out.body).toBe(`![Again](${path})`);
    const missing = "/media/00000000000000000000000000000000.jpg";
    const error = await refused(media.localize(db, "entry", { body: `![](${path})\n![Missing](${missing})` }));
    expect(error.code).toBe("image_failed");
    expect(error.message).toContain(missing);
    const first = await refused(media.localize(db, "entry", { cover: "https://example.com/gone", cover_alt: "Cover", body: `![Missing](${missing})` }, async () => new Response("gone", { status: 404 })));
    expect(first.message).toContain("404");
  });

  it("copies a cover in, by hash, and serves the same bytes back", async () => {
    const bytes = jpeg(4_100_000); // three chunks
    const out = await media.localize(db, "entry", { title: "x", cover: "https://example.com/a.jpg", cover_alt: "A boat" }, serving(bytes));
    expect(out.cover).toMatch(media.LOCAL);
    const again = await media.localize(db, "entry", { cover: "https://example.com/copy.jpg", cover_alt: "Same" }, serving(bytes));
    expect(again.cover).toBe(out.cover);
    const res = await media.serve(db, String(out.cover).slice("/media/".length), true);
    expect(res?.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(bytes);
  });

  it("copies body images and leaves the description", async () => {
    const out = await media.localize(db, "entry", { body: "Look:\n\n![The dock at dawn](https://example.com/d.jpg)" }, serving(jpeg(1000, 3)));
    expect(String(out.body)).toMatch(/^Look:\n\n!\[The dock at dawn\]\(\/media\/[0-9a-f]{32}\.jpg\)$/);
  });

  it("refuses an image with no description", async () => {
    const e = await refused(media.localize(db, "card", { image: "https://example.com/c.jpg" }, serving(jpeg(100))));
    expect(e.code).toBe("invalid");
    expect(JSON.stringify(e.toJSON())).toContain("image_alt");
    const b = await refused(media.localize(db, "entry", { body: "![](https://example.com/c.jpg)" }, serving(jpeg(100))));
    expect(JSON.stringify(b.toJSON())).toContain("needs a description");
  });

  it("refuses what isn't an image, is too big, or doesn't answer", async () => {
    const page = new TextEncoder().encode("<html>not an image</html>");
    expect((await refused(media.localize(db, "entry", { cover: "https://example.com/p", cover_alt: "x" }, serving(page)))).code).toBe("image_failed");
    const big = await refused(media.localize(db, "entry", { cover: "https://example.com/big.jpg", cover_alt: "x" }, serving(jpeg(media.MAX_BYTES + 1))));
    expect(big.message).toContain("8 MB");
    const gone: media.Fetcher = async () => new Response("no", { status: 404 });
    expect((await refused(media.localize(db, "entry", { cover: "https://example.com/gone.jpg", cover_alt: "x" }, gone))).message).toContain("404");
    expect((await refused(media.localize(db, "entry", { cover: "/media/0123456789abcdef0123456789abcdef.jpg", cover_alt: "x" }))).code).toBe("image_failed");
  });

  it("a site path it gave out is accepted on save, and shows once published", async () => {
    const path = await media.store(db, jpeg(500, 9), "image/jpeg", "test");
    const a = await content.createItem(db, who, "entry", { title: "With a cover", date: "2026-10-09", cover: path, cover_alt: "A photo" }, undefined);
    expect(a.data.cover).toBe(path);
    const v = site.view(await content.siteData(db, false), [{ id: a.id, kind: "entry", slug: a.slug, data: a.data }]);
    const homeHtml = await site.home(v).text();
    expect(homeHtml).toContain(`src="${path}"`);
    expect(homeHtml).toContain('alt="A photo"');
  });

  it("an image is public only once a published item uses it (S1)", async () => {
    const path = await media.store(db, jpeg(600, 11), "image/jpeg", "test");
    const name = path.slice("/media/".length);
    const a = await content.createItem(db, who, "card", { name: "Pictured", description: "d", image: path, image_alt: "x" }, undefined);
    expect(await media.published(db, name)).toBe(false);
    const req = await approvals.request(db, who, [a.id], "");
    await approvals.decide(db, req.id, { [a.id]: { decision: "approve" } }, "");
    expect(await media.published(db, name)).toBe(true);
    expect((await media.serve(db, name, true))?.headers.get("cache-control")).toContain("immutable");
    expect((await media.serve(db, name, false))?.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses non-https image links in the schema", async () => {
    const e = await refused(content.createItem(db, who, "card", { name: "C", description: "d", image: "http://example.com/x.jpg", image_alt: "x" }, undefined));
    expect(e.code).toBe("invalid");
  });
});

describe("streams", () => {
  it("an old site item's entries heading becomes its first stream", () => {
    const s = content.validate("site", { entries_title: "The diary" });
    expect(s.streams).toEqual([{ id: "journal", title: "The diary", byline: "", layout: "list", link_label: "", intro: "", author: "", nav_label: "", path: "", anchor: "", description: "", feed_subtitle: "", see_also_label: "", all_label: "", dated_addresses: true }]);
  });

  it("refuses sections and entries that name no stream", async () => {
    expect((await refused(Promise.resolve().then(() => content.validate("site", { sections: ["writing"] })))).message).toContain("doesn't validate");
    const e = await refused(content.createItem(db, who, "entry", { title: "Lost", date: "2026-10-09", stream: "nowhere" }, undefined));
    expect(JSON.stringify(e.toJSON())).toContain("no stream");
  });

  it("each stream is its own section; an external entry links out, with no page", () => {
    const s = content.validate("site", {
      streams: [{ id: "journal", title: "Journal" }, { id: "writing", title: "My writing", layout: "cards", link_label: "X Article" }],
      sections: ["writing", "entries", "about"],
    });
    const v = site.view(s, [
      { id: "e1", kind: "entry", slug: "2026-10-09-a", data: content.validate("entry", { title: "Daily note", date: "2026-10-09", stats: [{ value: "12", label: "commits" }] }) },
      {
        id: "e2",
        kind: "entry",
        slug: "2026-10-08-b",
        data: content.validate("entry", { title: "An article", date: "2026-10-08", stream: "writing", external_url: "https://example.com/post", cover: "/media/0123456789abcdef0123456789abcdef.jpg", cover_alt: "x" }),
      },
    ]);
    return site.home(v).text().then(async (h) => {
      expect(h.indexOf("My writing")).toBeLessThan(h.indexOf("Journal"));
      expect(h).toContain('href="https://example.com/post">X Article →');
      expect(site.entryPage(v, "/writing/2026-10-08-b/")?.status).toBe(302);
      expect(await site.entryPage(v, "/journal/2026-10-09-a/")!.text()).toContain("commits");
    });
  });
});
