// site_check finds links that lead nowhere and empty sections (SPEC §4).
// Port-matched: server/tests/app/test_check.py.
import { describe, expect, it } from "vitest";
import { checkSite } from "../src/check";
import { validate } from "../src/content";
import * as site from "../src/site";

const s = validate("site", {
  title: "Lunch club",
  cta_label: "Join the lunch",
  cta_link: "/journal/monthly-lunch/",
  buttons: [{ label: "Projects", url: "/#cards", note: "" }],
  streams: [{ id: "updates", title: "Updates", path: "news" }],
  sections: ["entries", "cards", "about"],
});
const entry = (id: string, slug: string, body: string) => ({ id, kind: "entry", slug, data: validate("entry", { title: id, date: "2026-10-10", body, tags: ["lunch"] }) });

describe("site_check", () => {
  it("reports links that lead nowhere and sections with nothing in them", async () => {
    const v = site.view(s, [entry("e1", "monthly-lunch", "See [the lunch](/news/monthly-lunch/), [tea](/news/tags/lunch/) and ![a photo](/media/abc.jpg). Also [old](/news/gone/) and ![missing](/media/nope.jpg).")]);
    const r = await checkSite(v, new Set(["abc.jpg"]));
    expect(r.ok).toBe(false);
    expect(r.broken).toEqual([
      { where: "site cta_link", link: "/journal/monthly-lunch/", why: "no page at that address" },
      { where: "site buttons[0] url", link: "/#cards", why: "the home page has no section #cards with anything in it" },
      { where: "entry e1 body", link: "/news/gone/", why: "no page at that address" },
      { where: "entry e1 body", link: "/media/nope.jpg", why: "this site has no picture by that name" },
    ]);
    expect(r.empty_sections).toEqual(["cards", "about"]);
  });

  it("passes a site whose links all land", async () => {
    const ok = validate("site", { title: "Ok", cta_label: "Read", cta_link: "/news/hello/", streams: [{ id: "updates", title: "Updates", path: "news" }], sections: ["entries"] });
    expect(await checkSite(site.view(ok, [entry("e1", "hello", "Back [home](/#updates).")]), new Set())).toEqual({ ok: true, broken: [], empty_sections: [], unreachable: [] });
  });
});


it("follows a rendered archive and relative links, and decodes external destinations", async () => {
  const data = validate("site", { title: "Paths", theme: "product-page", sections: ["entries"] });
  const v = site.view(data, [entry("a", "a", ""), entry("b", "b", ""), {
    ...entry("external", "external", ""), data: validate("entry", { title: "External", date: "2026-10-10", external_url: "https://example.com/?a=1&b=2" }),
  }]);
  const look = { manifest: {}, partials: {}, static: {}, pages: {
    home: '<!-- <a href="/journal/b/"> --> <a href="journal/">Archive</a>',
    archive: '<a href="a/">A</a>',
    entry: '{{#entry}}{{#body_html}}{{{body_html}}}{{/body_html}}{{/entry}}<a href="../b/">B</a><a href="https://example.com/?a=1&amp;b=2">External</a>',
  } };
  expect((await checkSite(v, new Set(), look)).unreachable).toEqual([]);
  look.pages.home = '<script>"<a href="/journal/a/">"</script><!-- <a href="/journal/b/"> -->';
  expect((await checkSite(v, new Set(), look)).unreachable.map(x => x.id)).toEqual(["a", "b", "external"]);
});
