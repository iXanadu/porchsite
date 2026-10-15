import { sourceData } from "./embed-storage";
/**
 * The public site, rendered from `live` only: nothing a visitor sees has
 * skipped the owner's approval. This built-in look is the first template;
 * every word on it comes from content (SPEC §6).
 */
import { bodyMarkdown, finishEmbeds, frameCsp, PERMISSIONS } from "./embeds";
import { dateFormatter, dateString } from "./date-format";
import { stringsOf } from "./strings";
import { siteData, toItem, validate } from "./content";
import { SITE_ID } from "./models";
import { sizeOf } from "./media";
import { html, markdown, type Raw, raw, respond } from "./html";

type Data = Record<string, any>;

interface LiveRow {
  item_id: string;
  kind: string;
  slug: string | null;
  version: number;
  data: string;
  published_at: string;
}

export interface SiteView {
  site: Data;
  entries: Data[];
  cards: Data[];
  notes: Data[];
  /** When the site last changed, for themes that say so. */
  updated: string;
  /** The hero image's pixel size, when known. */
  hero_size: [number, number];
  /** Each entry's share card, /media/<name>, when it matches the entry's version. */
  share_cards?: Record<string, string>;
  /** When the page is being made (tests set it); default: now. */
  now?: Date;
}

/** Build the view from rows shaped like `live` (the owner's preview passes its own). */
export function view(site: Data, rows: { id: string; kind: string; slug: string | null; data: Data; created?: string }[]): SiteView {
  const streams = (site.streams as Data[]).map((x) => x.id);
  const pathOf = Object.fromEntries((site.streams as Data[]).map((x) => [x.id, x.path || x.id]));
  // Newest created first, so the date sorts below leave same-day items that way.
  rows = [...rows].sort((a, b) => ((a.created ?? "") < (b.created ?? "") ? 1 : (a.created ?? "") > (b.created ?? "") ? -1 : 0));
  const entries = rows
    .filter((r) => r.kind === "entry" && r.data.status !== "draft")
    .map((r): Data => {
      // An unknown or empty stream reads as the first, so no entry goes missing.
      const stream = streams.includes(r.data.stream) ? r.data.stream : streams[0];
      const page = `/${pathOf[stream]}/${r.slug}/`;
      return { ...r.data, id: r.id, slug: r.slug, stream, page, url: r.data.external_url || page };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  // A private card is never shown; a mention shows its name and description only.
  const cards = rows
    .filter((r) => r.kind === "card" && r.data.visibility !== "private")
    .map((r): Data => (r.data.visibility === "mention" ? { ...r.data, link: "", link_label: "", image: "", image_alt: "", id: r.id } : { ...r.data, id: r.id }))
    .sort((a, b) => a.sort - b.sort || String(a.name).localeCompare(String(b.name)));
  const notes = rows
    .filter((r) => r.kind === "note")
    .map((r): Data => ({ ...r.data, id: r.id }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 12);
  return { site, entries, cards, notes, updated: "", hero_size: [0, 0] };
}

export async function liveView(db: D1Database): Promise<SiteView> {
  return proposedView(db, []);
}

/**
 * The site as it would be with these item versions published on top of
 * what's live (an approval's items); [] is the live site. `ready` names an
 * entry to show even if it is a draft (the writing desk's preview).
 */
export async function proposedView(db: D1Database, changes: { id: string; version: number }[], ready?: string): Promise<SiteView> {
  const { results } = await db
    .prepare("SELECT l.*, i.created_at FROM live l LEFT JOIN items i ON i.id = l.item_id ORDER BY l.item_id")
    .all<LiveRow & { created_at: string | null }>();
  const rows = new Map(
    results.map((r) => [r.item_id, { id: r.item_id, kind: r.kind, slug: r.slug, data: JSON.parse(r.data) as Data, published_at: r.published_at, created: r.created_at ?? "", version: r.version }]),
  );
  const now = new Date().toISOString();
  // Every change's revision in one query.
  const { results: revs } = changes.length
    ? await db
        .prepare(
          "SELECT r.item_id, r.version, r.data, r.deleted, i.kind, i.slug, i.created_at FROM json_each(?) j JOIN revisions r ON r.item_id = json_extract(j.value, '$.id') AND r.version = json_extract(j.value, '$.version') JOIN items i ON i.id = r.item_id",
        )
        .bind(JSON.stringify(changes.map((c) => ({ id: c.id, version: c.version }))))
        .all<{ item_id: string; version: number; data: string; deleted: number; kind: string; slug: string | null; created_at: string }>()
    : { results: [] };
  const byChange = new Map(revs.map((r) => [`${r.item_id}@${r.version}`, r]));
  for (const c of changes) {
    const rev = byChange.get(`${c.id}@${c.version}`);
    if (!rev) continue;
    if (rev.deleted) rows.delete(c.id);
    else rows.set(c.id, { id: c.id, kind: rev.kind, slug: rev.slug, data: JSON.parse(rev.data), published_at: now, created: rev.created_at, version: c.version });
  }
  // The writing desk's preview shows a draft as it will look once published.
  const shown = ready ? rows.get(ready) : undefined;
  if (shown) shown.data = { ...shown.data, status: "ready" };
  const siteRow = rows.get(SITE_ID);
  const site = validate("site", siteRow ? await sourceData(db, SITE_ID, siteRow.version, siteRow.data, !changes.some(c => c.id === SITE_ID)) : {});
  const v = view(site, [...rows.values()].filter((r) => r.kind !== "site"));
  const { results: cards } = await db.prepare("SELECT item_id, version, name FROM share_cards").all<{ item_id: string; version: number; name: string }>();
  v.share_cards = Object.fromEntries(cards.filter((c) => rows.get(c.item_id)?.version === c.version).map((c) => [c.item_id, `/media/${c.name}`]));
  const hero = /^\/media\/([0-9a-f]{32}\.(?:jpg|png|webp))$/.exec(String(site.hero));
  if (hero) {
    v.hero_size = await sizeOf(db, hero[1]);
  }
  const last = [...rows.values()].reduce((m, r) => (r.published_at > m ? r.published_at : m), "");
  if (last) {
    const d = new Date(last);
    const timeZone = String(site.timezone || "UTC");
    const time = dateString(d, { hour: "numeric", minute: "2-digit" }, timeZone);
    const day = dateString(d, { month: "short", day: "numeric" }, timeZone);
    // "EDT" / "EST" read better as "ET" (likewise CT, MT, PT).
    const zone = (dateFormatter({ timeZoneName: "short" }, timeZone).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "UTC").replace(/^([ECMP])[SD]T$/, "$1T");
    v.updated = `${day}, ${time} ${zone}`;
  }
  return v;
}

const longDate = (d: string) =>
  dateString(new Date(`${d}T12:00:00Z`), { month: "long", day: "numeric", year: "numeric" });
const shortDate = (d: string) =>
  dateString(new Date(`${d}T12:00:00Z`), { month: "short", day: "numeric" });

const CSS = `
:root{--bg:#f6f4ef;--card:#fffdf8;--ink:#1d1f1c;--body:#363a34;--muted:#5b6159;--rule:#ddd8cc;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root{--bg:#161816;--card:#1e211e;--ink:#eceae4;--body:#d3d1ca;--muted:#a3a79f;--rule:#343833;--accent:#8cc4b2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--body);font:17px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:0 18px 64px}header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:18px 0;border-bottom:1px solid var(--rule)}
.logo{font-weight:700;color:var(--ink);text-decoration:none}nav a{color:var(--muted);margin-left:14px;text-decoration:none;font-size:15px}
h1,h2,h3{color:var(--ink);line-height:1.25;font-family:Georgia,"Times New Roman",serif}h1{font-size:34px;margin:36px 0 10px}h2{font-size:24px;margin:44px 0 14px}
a{color:var(--accent)}.lede{font-size:19px}.meta{color:var(--muted);font-size:14px}
.entry,.card{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:18px;margin:14px 0}
.entry h3{margin:4px 0 6px;font-size:21px}.entry h3 a{color:var(--ink);text-decoration:none}
.cards{display:grid;gap:14px}@media(min-width:620px){.cards{grid-template-columns:1fr 1fr}}.card{margin:0}
.card h3{margin:0 0 6px;font-size:18px}.badge{font-size:12px;border:1px solid var(--rule);border-radius:99px;padding:2px 8px;color:var(--muted)}
.notes{list-style:none;padding:0}.notes li{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--rule)}.notes .meta{min-width:56px}
article img,.hero,.cover{max-width:100%;height:auto;border-radius:8px;display:block}.hero{margin:24px 0 0;width:100%}
.entry .cover{margin:-18px -18px 14px;max-width:calc(100% + 36px);width:calc(100% + 36px);border-radius:10px 10px 0 0;aspect-ratio:16/9;object-fit:cover}
.card .cover{margin-bottom:12px;width:100%;aspect-ratio:16/9;object-fit:cover}article .cover{margin:18px 0}footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);color:var(--muted);font-size:14px}
.tags a{margin-right:8px;font-size:14px}.byline{color:var(--muted);margin:-8px 0 14px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.stat{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:10px 14px;min-width:96px}
.stat b{display:block;font-size:22px;color:var(--ink)}.stat span{color:var(--muted);font-size:13px}
.card h3 a{color:var(--ink);text-decoration:none}`;

// The kit's beacon (SPEC §8) is the page's only script, and posts to this site only.
const BUILTIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function page(v: SiteView, title: string, description: string, main: Raw, kind: string, id = "", origin = "", provenance?: unknown): Response {
  const s = v.site;
  return respond(
    raw(finishEmbeds(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="description" content="${description}"><meta property="og:title" content="${title}">
<meta property="og:description" content="${description}"><style>${raw(CSS)}</style></head>
<body data-kind="${kind}" data-id="${id}"><div class="wrap"><header><a class="logo" href="/">${s.title}</a><nav>${s.links.map(
      (l: Data) => html`<a href="${l.url}">${l.label}</a>`,
    )}</nav></header><main>${main}</main>
<footer>${s.owner_name ? html`${s.owner_name} · ` : ""}${s.footer_line || raw("Kept up to date by an assistant, published with the owner's approval.")}</footer></div><script src="/static/a.js" defer></script></body></html>`.html, origin ? s.embed_sources : [], origin, provenance)),
    { headers: { "Cache-Control": "no-cache", ...(origin ? {"Permissions-Policy": PERMISSIONS} : {}) }, csp: frameCsp(BUILTIN_CSP, origin ? s.embed_sources : [], origin) },
  );
}

function entryTile(e: Data, stream: Data): Raw {
  return html`<div class="card">${e.cover ? html`<a href="${e.url}"><img class="cover" src="${e.cover}" alt="${e.cover_alt}" loading="lazy"></a>` : ""}<div class="meta">${longDate(e.date)}</div><h3><a href="${e.url}">${e.title}</a></h3>${
    e.summary ? html`<p>${e.summary}</p>` : ""
  }${e.external_url ? html`<a href="${e.url}">${stream.link_label || "Read"} →</a>` : ""}</div>`;
}

function streamSection(v: SiteView, stream: Data): Raw | string {
  const items = v.entries.filter((e) => e.stream === stream.id).slice(0, 10);
  if (!items.length) return "";
  const head = html`<h2>${stream.title}</h2>${stream.byline ? html`<p class="byline">${stream.byline}</p>` : ""}`;
  return stream.layout === "cards"
    ? html`<section id="${stream.id}">${head}<div class="cards">${items.map((e) => entryTile(e, stream))}</div></section>`
    : html`<section id="${stream.id}">${head}${items.map(entryCard)}</section>`;
}

function entryCard(e: Data): Raw {
  return html`<div class="entry">${e.cover ? html`<a href="${e.url}"><img class="cover" src="${e.cover}" alt="${e.cover_alt}" loading="lazy"></a>` : ""}<div class="meta">${longDate(e.date)}</div><h3><a href="${e.url}">${e.title}</a></h3>${
    e.summary ? html`<p>${e.summary}</p>` : ""
  }</div>`;
}

export function home(v: SiteView, origin = ""): Response {
  const s = v.site;
  const streams = s.streams as Data[];
  const named = new Set(s.sections as string[]);
  const sections: Record<string, Raw | string> = {
    // "entries" stands for every stream the owner didn't place by name.
    entries: html`${streams.filter((x) => !named.has(x.id)).map((x) => raw(String(streamSection(v, x))))}`,
    ...Object.fromEntries(streams.map((x) => [x.id, streamSection(v, x)])),
    cards: v.cards.length
      ? html`<section><h2>${s.cards_title}</h2><div class="cards">${v.cards.map(
          (c) =>
            html`<div class="card">${c.image ? html`<img class="cover" src="${c.image}" alt="${c.image_alt}" loading="lazy">` : ""}<h3>${c.name} ${c.badge ?? c.status ? html`<span class="badge">${c.badge ?? c.status}</span>` : ""}</h3><p>${c.description}</p>${
              c.link ? html`<a href="${c.link}">${c.link_label || c.link}</a>` : ""
            }</div>`,
        )}</div></section>`
      : "",
    notes: v.notes.length
      ? html`<section><h2>${s.notes_title}</h2><ul class="notes">${v.notes.map(
          (n) => html`<li><span class="meta">${shortDate(n.date)}</span><span>${n.link ? html`<a href="${n.link}">${n.text}</a>` : n.text}</span></li>`,
        )}</ul></section>`
      : "",
    about: s.about ? html`<section><h2>${s.about_title}</h2>${markdown(s.about)}</section>` : "",
  };
  const main = html`${s.hero ? html`<img class="hero" src="${s.hero}" alt="${s.hero_alt}">` : ""}<h1>${s.tagline || s.title}</h1>${s.intro ? html`<p class="lede">${s.intro}</p>` : ""}${s.sections.map((k: string) => raw(String(sections[k] ?? "")))}`;
  return page(v, s.title, s.tagline || s.intro.slice(0, 160), main, "home", "", origin);
}

/** An entry's page, at its address (/<stream path>/<slug>/). */
export function entryPage(v: SiteView, address: string, origin = ""): Response | null {
  const e = v.entries.find((x) => x.page === address);
  if (!e) return null;
  // A post that lives elsewhere has no page here; its address goes there.
  if (e.external_url) return Response.redirect(e.external_url, 302);
  const body = bodyMarkdown(e.body);
  const main = html`<article><p class="meta"><a href="/">← ${v.site.title}</a></p><div class="meta">${longDate(e.date)}</div><h1>${e.title}</h1>${
    e.summary ? html`<p class="lede">${e.summary}</p>` : ""
  }${e.cover ? html`<img class="cover" src="${e.cover}" alt="${e.cover_alt}">` : ""}${
    (e.stats ?? []).length ? html`<div class="stats">${e.stats.map((x: Data) => html`<div class="stat"><b>${x.value}</b><span>${x.label}</span></div>`)}</div>` : ""
  }${raw(body)}${e.tags.length ? html`<p class="tags">${e.tags.map((t: string) => html`<span class="meta">#${t}</span> `)}</p>` : ""}</article>`;
  return page(v, `${e.title} · ${v.site.title}`, e.summary || e.title, main, "entry", e.id, origin, body);
}

/**
 * Where a missing page lives now, or null. Two cases: the address lacks its
 * trailing slash, or it names a stream by its id after the stream moved to
 * another path (/journal/x/ once the journal lives at /reports/). Only real
 * pages are answered, so nothing else on the site can be redirected.
 */
export function redirectFor(v: SiteView, path: string): string | null {
  const streams = v.site.streams as Data[];
  let to = path;
  const seg = /^\/([a-z][a-z0-9-]{0,29})(\/.*)?$/.exec(to);
  const moved = seg && streams.find((x) => x.id === seg[1] && (x.path || x.id) !== x.id);
  if (moved && !streams.some((x) => (x.path || x.id) === seg![1])) to = `/${moved.path}${seg![2] ?? "/"}`;
  if (!to.endsWith("/")) to += "/";
  if (to === path) return null;
  const paths = new Set(streams.map((x) => x.path || x.id));
  const arch = /^\/([a-z][a-z0-9-]{0,29})\/(?:tags\/[a-z0-9-]{1,30}\/)?$/.exec(to);
  const real = (arch && paths.has(arch[1])) || v.entries.some((e) => e.page === to);
  return real ? to : null;
}

export function notFound(v: SiteView, origin = ""): Response {
  const t = stringsOf(v.site);
  const r = page(v, `${t.not_found_title} · ${v.site.title}`, "", html`<h1>${t.not_found_title}</h1><p><a href="/">${v.site.title}</a></p>`, "notfound", "", origin);
  const headers = new Headers(r.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(r.body, { status: 404, headers });
}

export { toItem };
