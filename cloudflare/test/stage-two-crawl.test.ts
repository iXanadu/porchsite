import { expect, it } from "vitest";
import { checkSiteDeep as checkSite } from "../src/check";
import { validate } from "../src/content";
import { view } from "../src/site";

const data = validate("site", { title: "Test", theme: "product-page", sections: ["entries"] });
const entry = { id: "orphan", kind: "entry", slug: "orphan", data: validate("entry", { title: "Orphan", date: "2026-10-10", body: "Body" }) };
const look = (home: string) => ({ manifest: {}, partials: {}, static: {}, pages: { home, entry: "Entry" } });

it.each([199, 200])("bounds unique local addresses with %i outgoing links", async count => {
  const home = Array.from({ length: count }, (_, i) => `<a href="/missing-${i}/">Link</a>`).join("");
  const result = await checkSite(view(data, [entry]), new Set(), look(home));
  if (count === 199) {
    expect(result.crawl).toBeUndefined();
    expect(result.unreachable.map(x => x.id)).toEqual(["orphan"]);
  } else expect(result).toMatchObject({ ok: false, unreachable: [], crawl: { limit: "pages", max_pages: 200, max_links: 10000, pages: 200, links: 200 } });
});

it.each([10000, 10001])("counts duplicate nonHTTP links at boundary %i", async count => {
  const result = await checkSite(view(data, [entry]), new Set(), look('<a href="mailto:owner@example.com">Mail</a>'.repeat(count)));
  if (count === 10000) {
    expect(result.crawl).toBeUndefined();
    expect(result.unreachable.map(x => x.id)).toEqual(["orphan"]);
  } else expect(result).toMatchObject({ ok: false, unreachable: [], crawl: { limit: "links", max_pages: 200, max_links: 10000, pages: 1, links: 10000 } });
});

it("ignores inert links and charges repeated addresses once", async () => {
  const home = '<template><a href="/missing/">Inert</a></template>'.repeat(10001) + '<a href="/">Home</a>'.repeat(10000);
  const result = await checkSite(view(data, []), new Set(), look(home));
  expect(result.ok).toBe(true);
  expect(result.crawl).toBeUndefined();
});

it("retains broken-link diagnostics when traversal is truncated", async () => {
  const result = await checkSite(view({ ...data, cta_link: "/missing/" }, [entry]), new Set(), look('<a href="/">Home</a>'.repeat(10001)));
  expect(result.ok).toBe(false);
  expect(result.broken[0].link).toBe("/missing/");
  expect(result.empty_sections).toEqual([]);
  expect(result.unreachable).toEqual([]);
  expect(result.crawl?.limit).toBe("links");
});

it("shares the link budget across rendered pages", async () => {
  const home = '<a href="mailto:owner@example.com">Mail</a>'.repeat(5000) + '<a href="/journal/orphan/">Entry</a>';
  const theme = { ...look(home), pages: { home, entry: '<a href="mailto:owner@example.com">Mail</a>'.repeat(5000) } };
  const result = await checkSite(view(data, [entry]), new Set(), theme);
  expect(result.crawl).toEqual({ limit: "links", max_pages: 200, max_links: 10000, pages: 2, links: 10000 });
  expect(result.ok).toBe(false);
  expect(result.unreachable).toEqual([]);
});

it("counts a redirect address before its destination", async () => {
  const home = Array.from({ length: 198 }, (_, i) => `<a href="/missing-${i}/">Link</a>`).join("") + '<a href="/e/orphan/">Old address</a>';
  const result = await checkSite(view(data, [entry]), new Set(), look(home));
  expect(result.crawl).toEqual({ limit: "pages", max_pages: 200, max_links: 10000, pages: 200, links: 199 });
  expect(result.ok).toBe(false);
  expect(result.unreachable).toEqual([]);
});
