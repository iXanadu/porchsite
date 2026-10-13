/**
 * site_check: the site as it will be once everything staged is published,
 * looked over the way a visitor would click through it (SPEC §4). Links
 * inside the site that lead nowhere (a page, a section, a picture) and
 * sections in the layout with nothing in them. Read-only; the server
 * edition's server/app/check.py is the same check.
 */
import type { SiteView } from "./site";
import { streams } from "./theme";

type Data = Record<string, any>;
export interface Problem {
  where: string;
  link: string;
  why: string;
}

// Addresses every site answers that aren't content.
const FIXED = new Set(["/", "/review/", "/login/", "/robots.txt", "/sitemap.xml"]);
const MD_LINK = /\]\(\s*(\/[^)\s]*)/g;

/** Every internal link an item carries, with where it sits. */
function linksOf(where: string, data: Data, fields: string[]): { where: string; link: string }[] {
  const out: { where: string; link: string }[] = [];
  const add = (field: string, v: unknown) => {
    if (typeof v === "string" && v.startsWith("/") && !v.startsWith("//")) out.push({ where: `${where} ${field}`, link: v });
  };
  for (const f of fields) {
    const v = data[f];
    if (typeof v === "string") {
      add(f, v);
      for (const m of v.matchAll(MD_LINK)) add(f, m[1]);
    }
  }
  return out;
}

export function checkSite(v: SiteView, media: Set<string>): { ok: boolean; broken: Problem[]; empty_sections: string[] } {
  const s = v.site;
  const st = streams(s);
  const pages = new Set(FIXED);
  for (const x of st) {
    pages.add(x.archive_url);
    pages.add(x.feed_url);
  }
  for (const e of v.entries) {
    const x = st.find((y) => y.id === e.stream) ?? st[0];
    if (!e.external_url) pages.add(e.page);
    for (const t of (e.tags ?? []) as string[]) pages.add(`${x.archive_url}tags/${t}/`);
  }

  // The home page's sections, in the owner's order, and which have something in them.
  const order = (s.sections as string[]).flatMap((k) => (k === "entries" ? st.filter((x) => !(s.sections as string[]).includes(x.id)).map((x) => x.id) : [k]));
  const anchors = new Set<string>();
  const empty: string[] = [];
  for (const k of order) {
    const x = st.find((y) => y.id === k);
    const filled = k === "cards" ? v.cards.length > 0 : k === "about" ? !!String(s.about ?? "").trim() : k === "notes" ? v.notes.length > 0 : v.entries.some((e) => e.stream === k);
    const anchor = x ? x.anchor : k === "cards" ? s.cards_anchor || "cards" : k;
    if (filled) anchors.add(anchor);
    else empty.push(x ? `${x.title} (${k})` : k);
  }

  const links = [
    ...linksOf("site", s, ["cta_link", "cta2_link", "intro", "about"]),
    ...((s.links ?? []) as Data[]).flatMap((l, i) => linksOf(`site links[${i}]`, l, ["url"])),
    ...((s.buttons ?? []) as Data[]).flatMap((b, i) => linksOf(`site buttons[${i}]`, b, ["url"])),
    ...v.entries.flatMap((e) => linksOf(`entry ${e.id}`, e, ["body", "summary", "cover"])),
    ...v.cards.flatMap((c) => linksOf(`card ${c.id}`, c, ["link", "description", "image"])),
    ...v.notes.flatMap((n) => linksOf(`note ${n.id}`, n, ["link"])),
  ];
  const broken: Problem[] = [];
  for (const { where, link } of links) {
    const [rest, hash = ""] = link.split("#");
    const path = rest.split("?")[0] || "/";
    if (path.startsWith("/media/")) {
      if (!media.has(path.slice("/media/".length))) broken.push({ where, link, why: "this site has no picture by that name" });
      continue;
    }
    if (path.startsWith("/static/")) continue;
    const page = path.endsWith("/") || /\.[a-z]+$/.test(path) ? path : `${path}/`;
    if (!pages.has(page)) {
      broken.push({ where, link, why: "no page at that address" });
      continue;
    }
    if (hash && page === "/" && !anchors.has(hash)) broken.push({ where, link, why: `the home page has no section #${hash} with anything in it` });
  }
  // Empty sections are reported, not failed: the site's menu leaves them out.
  return { ok: !broken.length, broken, empty_sections: empty };
}
