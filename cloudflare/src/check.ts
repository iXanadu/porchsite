/**
 * site_check: the site as it will be once everything staged is published,
 * looked over the way a visitor would click through it (SPEC §4). Links
 * inside the site that lead nowhere (a page, a section, a picture) and
 * sections in the layout with nothing in them. Read-only; the server
 * edition's server/app/check.py is the same check.
 */
import { decodeHTMLAttribute } from "entities";
import type { SiteView } from "./site";
import { streams, homeView, archiveView, entryView, render } from "./theme";
import { THEMES } from "./themes.gen";
import { ALIASES, type Theme } from "./themes";
import { allArchivePage, home, entryPage, redirectFor } from "./site";

type Data = Record<string, any>;
interface CrawlLimit { limit: "pages" | "links"; max_pages: number; max_links: number; pages: number; links: number }
const MAX_PAGES = 200;
const MAX_LINKS = 10_000;

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
  if (s.archive?.enabled) pages.add("/archive/");
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

export async function checkSiteDeep(v: SiteView, media: Set<string>, look?: Theme | null, origin = "https://example.invalid"): Promise<{ ok: boolean; broken: Problem[]; empty_sections: string[]; unreachable: { id: string; why: string }[]; crawl?: CrawlLimit }> {
  const { broken, empty_sections: empty } = checkSite(v, media);
  const { unreachable, crawl } = await unreachableEntries(v, look, origin);
  return { ok: !broken.length && !unreachable.length && !crawl, broken, empty_sections: empty, unreachable, ...(crawl ? { crawl } : {}) };
}

/** Crawl only pages reached by actual HTML links; never fetch a URL. */
async function unreachableEntries(v: SiteView, look: Theme | null | undefined, origin: string) {
  const t = look === undefined ? THEMES[ALIASES[v.site.theme] ?? v.site.theme] ?? null : look;
  const base = new URL(origin || "https://example.invalid");
  const remaining = new Set(v.entries.map(e => e.id));
  if (!remaining.size) return { unreachable: [], crawl: undefined };
  const byPage = new Map(v.entries.map(e => [e.page, e]));
  const bySlug = new Map(v.entries.map(e => [e.slug, e]));
  const external = new Map<string, string[]>();
  for (const e of v.entries) if (e.external_url) {
    const url = new URL(e.external_url, base).href;
    external.set(url, [...(external.get(url) ?? []), e.id]);
  }
  // Resolve the same current-view routes as the public renderer. Mere path
  // resemblance, stored archive membership, or another view is not evidence.
  const movedPath = (path: string): string | null => {
    const old = /^\/e\/([a-z0-9-]+)\/?$/.exec(path);
    return old ? bySlug.get(old[1])?.page ?? null : redirectFor(v, path);
  };
  const target = (path: string): Data | undefined => {
    const seen = new Set<string>();
    while (!seen.has(path)) {
      seen.add(path);
      const old = /^\/e\/([a-z0-9-]+)\/?$/.exec(path);
      if (old) {
        const e = bySlug.get(old[1]);
        if (!e || e.external_url) return e;
        path = e.page;
        continue;
      }
      const e = byPage.get(path);
      if (e) return e;
      const moved = redirectFor(v, path);
      if (!moved) return undefined;
      path = moved;
    }
    return undefined; // A redirect cycle is not a renderable target.
  };
  const marker = `porchsite-check-${crypto.randomUUID()}:`;
  // Check-only comments identify full entry bodies that a look emits inline.
  // They never reach the public renderer, and do not change Mustache truthiness.
  const marked = (value: any): any => {
    if (Array.isArray(value)) return value.map(marked);
    if (!value || typeof value !== "object") return value;
    const out = Object.fromEntries(Object.entries(value).map(([k, val]) => [k, marked(val)]));
    const i = v.entries.findIndex((e) => e.id === value.id);
    if (i >= 0 && value.body_html) out.body_html = `<!--${marker}${i}-->${value.body_html}`;
    return out;
  };
  let links = 0;
  let limit: "pages" | "links" | undefined;
  const visited = new Set<string>();
  const queue = ["/"];
  const address = (href: string, path: string): URL | null => {
    try { return new URL(href, new URL(path, base)); } catch { return null; }
  };
  while (queue.length && remaining.size) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    if (visited.size === MAX_PAGES) { limit = "pages"; break; }
    visited.add(path);
    const moved = movedPath(path);
    if (moved) { queue.push(moved); continue; }
    const e = byPage.get(path);
    if (e?.external_url) continue;
    let body: string | null = null;
    if (path === "/archive/" && v.site.archive?.enabled) {
      body = await allArchivePage(v,{sort:"date",tag:"",stream:""},base.origin,!!t).text();
    } else if (t) {
      if (path === "/") body = render(t, "home", marked(homeView(v, "check", base.origin)));
      else if (e) body = render(t, "entry", marked(entryView(v, e, "check", base.origin)));
      else {
        const arch = /^\/([a-z][a-z0-9-]{0,29})\/(?:tags\/([a-z0-9-]{1,30})\/)?$/.exec(path);
        const av = arch && archiveView(v, arch[1], "check", base.origin, arch[2]);
        if (av) body = render(t, arch![2] ? "tag" : "archive", marked(av));
      }
    } else {
      const response = path === "/" ? home(v) : entryPage(v, path);
      if (response) body = await response.text();
    }
    if (body === null) continue;
    // Template content is inert even when templates nest. Use parser events,
    // so markup in script text and comments cannot change the nesting depth.
    let templateDepth = 0;
    await new HTMLRewriter().on("template", {
      element(el) {
        templateDepth++;
        el.onEndTag(() => { templateDepth--; });
      },
    }).on("a[href], area[href]", {
      element(el) {
        if (templateDepth || limit || !remaining.size) return;
        if (links === MAX_LINKS) { limit = "links"; return; }
        links++;
        const url = address(decodeHTMLAttribute(el.getAttribute("href")!), path);
        if (!url || !["http:", "https:"].includes(url.protocol)) return;
        for (const id of external.get(url.href) ?? []) remaining.delete(id);
        if (url.origin === base.origin) {
          const e = target(url.pathname);
          if (e) remaining.delete(e.id);
          queue.push(url.pathname);
        }
      },
    }).onDocument({ comments(comment) {
      if (!limit && remaining.size && !templateDepth && comment.text.startsWith(marker) && /^\d+$/.test(comment.text.slice(marker.length))) {
        const e = v.entries[Number(comment.text.slice(marker.length))];
        if (e) remaining.delete(e.id);
      }
    } }).transform(new Response(body)).text();
    if (limit) break;
  }
  if (limit) return { unreachable: [], crawl: { limit, max_pages: MAX_PAGES, max_links: MAX_LINKS, pages: visited.size, links } as CrawlLimit };
  return { unreachable: v.entries.filter((e) => remaining.has(e.id))
    .map((e) => ({ id: String(e.id), why: "no rendered link path from the home page to this entry" })), crawl: undefined };
}
