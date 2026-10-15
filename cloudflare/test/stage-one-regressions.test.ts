// Review regressions: inert nested templates and equivalent URL spellings.
// Port-matched: server/tests/app/test_stage_one_regressions.py.
import { expect, it } from "vitest";
import { checkSite } from "../src/check";
import { validate } from "../src/content";
import { view } from "../src/site";

const data = validate("site", { title: "Test", theme: "product-page", sections: ["entries"] });
const entry = (external_url = "") => ({ id: "entry", kind: "entry", slug: "entry", data: validate("entry", { title: "Entry", date: "2026-10-10", ...(external_url ? { external_url } : { body: "Full body" }) }) });
const look = (home: string) => ({ manifest: {}, partials: {}, static: {}, pages: { home, entry: "Entry" } });

it.each([
  '<template><template></template><a href="/journal/entry/">Inert</a></template>',
  '<template><template></template>{{#sections}}{{#latest}}{{{body_html}}}{{/latest}}{{/sections}}</template>',
])("ignores links and inline bodies within a nested template: %s", async home => {
  const result = await checkSite(view(data, [entry()]), new Set(), look(home));
  expect(result.ok).toBe(false);
  expect(result.unreachable.map(x => x.id)).toEqual(["entry"]);
});

it.each([
  ["https://example.com", "https://example.com/"],
  ["https://EXAMPLE.com:443", "https://example.com/"],
  ["https://example.com/", "HTTPS://EXAMPLE.COM:443"],
  ["https://EXAMPLE.com:443/article", "https://example.com/article"],
])("matches equivalent stored %s and rendered %s destinations", async (stored, rendered) => {
  const result = await checkSite(view(data, [entry(stored)]), new Set(), look(`<a href="${rendered}">External</a>`));
  expect(result.ok).toBe(true);
  expect(result.unreachable).toEqual([]);
});
