/**
 * What the owner reads on /review and /review/history: an item's fields in
 * plain words ("What it says"), and, for an item that is already live, only
 * what differs from the live version ("What changed"): old → new for short
 * values, a word-level diff for long text, thumbnails for pictures, and
 * added/removed entries for lists. Every value is escaped; nothing from
 * content is ever inserted as HTML except through markdown(), which escapes.
 * Port: server/server/app/changes.py (same strings, same structure).
 */
import { validate } from "./content";
import { ApiError } from "./errors";
import { html, markdown, type Raw } from "./html";
import * as media from "./media";
import { RANK } from "./visibility";

type Data = Record<string, unknown>;

/** Plain words for the fields a person sees on the review page. */
export const LABELS: Record<string, string> = {
  title: "Name", tagline: "Headline", intro: "Intro", description: "Description for search and shared links", about: "About",
  hero: "Main picture", logo: "Mark (and browser icon)", share_image: "Picture for shared links", hero_caption: "Line under the masthead",
  theme: "Look", palette: "Colours", links: "Menu", buttons: "Buttons", streams: "Sections", sections: "Order of the home page",
  cta_label: "Main button", cta2_label: "Second button", footer_line: "Footer", contact: "Contact details", hours: "Opening hours",
  notice: "Banner", handle: "X handle", summary: "Summary", body: "Text", cover: "Picture", date: "Date", name: "Name",
  price: "Price", subtitle: "Second line", period: "Dates", image: "Picture", event: "Event details", stats: "Figures", tags: "Tags",
  follow_image: "Photo by the Follow link", visibility: "Visibility", link: "Link", link_label: "Link words", external_url: "Link",
  badge: "Badge", badge_tone: "Badge colour", group: "Group", sort: "Order", status: "Status", stream: "Section", text: "Text",
  owner_name: "Your name", hero_alt: "Words for the main picture", logo_alt: "Words for the mark", follow_image_alt: "Words for the Follow photo",
  share_image_alt: "Words for the shared-link picture", cover_alt: "Words for the picture", image_alt: "Words for the picture",
  cta_link: "Main button link", cta2_link: "Second button link",
};
/** Per kind, where the shared word would mislead. */
const KIND_LABELS: Record<string, Record<string, string>> = { card: { description: "Description" } };
/** Fields "What it says" leaves out (alt text, order, styling); "What changed" still shows them when they change. */
export const SILENT = new Set(["hero_alt", "logo_alt", "follow_image_alt", "share_image_alt", "cover_alt", "image_alt", "cta_link", "cta2_link", "sort", "status", "badge_tone", "stream"]);

export function labelFor(kind: string, k: string): string {
  return KIND_LABELS[kind]?.[k] ?? LABELS[k] ?? k.replace(/_/g, " ");
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");

function plainValue(k: string, v: unknown): Raw | string {
  if (typeof v === "string") {
    if (!v) return html`<span class="meta">(empty)</span>`;
    if (media.LOCAL.test(v)) return html`<img src="${v}" alt="" style="max-width:100%;max-height:320px;height:auto;border-radius:8px">`;
    if (k === "body" || k === "about") return markdown(v);
    return v;
  }
  if (Array.isArray(v)) {
    const named = v.map((x) => (typeof x === "object" && x ? String((x as Data).label ?? (x as Data).title ?? (x as Data).value ?? "") : String(x))).filter(Boolean);
    return named.length ? named.join(" · ") : `${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  if (v && typeof v === "object") return "updated";
  return String(v ?? "");
}

/** "What it says": every field with something in it (a new item, or one coming back). */
export function fieldRows(kind: string, now: Data): Raw {
  return html`${Object.entries(now).map(([k, v]) => {
    if (SILENT.has(k)) return "";
    if (v === "" || v === null || (Array.isArray(v) && !v.length)) return "";
    return html`<div class="field"><b>${labelFor(kind, k)}</b><div class="value">${plainValue(k, v)}</div></div>`;
  })}`;
}

export function whatItSays(kind: string, now: Data, open: boolean): Raw {
  return html`<details${open ? " open" : ""}><summary class="meta" style="cursor:pointer">What it says</summary>${fieldRows(kind, now)}</details>`;
}

// --- what changed ---------------------------------------------------------------------

/** Text longer than this (or any body) gets a word diff instead of two copies. */
const LONG = 200;
/** Past this many word pairs (after the common start and end), the diff shows old and new whole. */
const MAX_CELLS = 250_000;
/** An unchanged stretch longer than this shows only its ends. */
const KEEP = 6;

const words = (s: string) => s.split(/[ \t\n\r]+/).filter((w) => w);

type Op = "same" | "del" | "ins";

/** Word-level diff of two texts: runs of unchanged, removed and added words. */
export function wordDiff(before: string, after: string): [Op, string[]][] {
  const a = words(before);
  const b = words(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const a1 = a.slice(p, a.length - s);
  const b1 = b.slice(p, b.length - s);
  const ops: [Op, string][] = a.slice(0, p).map((w) => ["same", w]);
  if (a1.length * b1.length > MAX_CELLS) {
    for (const w of a1) ops.push(["del", w]);
    for (const w of b1) ops.push(["ins", w]);
  } else {
    // Longest common subsequence, table from the end.
    const m = a1.length;
    const n = b1.length;
    const t: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) t[i][j] = a1[i] === b1[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && a1[i] === b1[j]) {
        ops.push(["same", a1[i]]);
        i++;
        j++;
      } else if (j >= n || (i < m && t[i + 1][j] >= t[i][j + 1])) ops.push(["del", a1[i++]]);
      else ops.push(["ins", b1[j++]]);
    }
  }
  for (const w of a.slice(a.length - s)) ops.push(["same", w]);
  const runs: [Op, string[]][] = [];
  for (const [op, w] of ops) {
    const last = runs[runs.length - 1];
    if (last && last[0] === op) last[1].push(w);
    else runs.push([op, [w]]);
  }
  return runs;
}

function diffHtml(before: string, after: string): Raw {
  const runs = wordDiff(before, after);
  const parts: Raw[] = runs.map(([op, ws], idx) => {
    if (op === "del") return html`<del>${ws.join(" ")}</del>`;
    if (op === "ins") return html`<ins>${ws.join(" ")}</ins>`;
    if (ws.length <= 2 * KEEP + 1) return html`${ws.join(" ")}`;
    const first = idx === 0;
    const last = idx === runs.length - 1;
    if (first) return html`… ${ws.slice(-KEEP).join(" ")}`;
    if (last) return html`${ws.slice(0, KEEP).join(" ")} …`;
    return html`${ws.slice(0, KEEP).join(" ")} … ${ws.slice(-KEEP).join(" ")}`;
  });
  return html`<div class="value diff">${parts.map((x, i) => html`${i ? " " : ""}${x}`)}</div>`;
}

function thumb(v: string): Raw {
  if (!v) return html`<span class="meta">(none)</span>`;
  if (media.LOCAL.test(v)) return html`<img src="${v}" alt="" style="max-width:40%;max-height:96px;height:auto;border-radius:6px;vertical-align:middle">`;
  return html`${v}`;
}

/** One entry of a list, or one part of a group of settings, in a few words. */
function entryName(x: unknown): string {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const o = x as Data;
    const main = o.label ?? o.title ?? o.value ?? o.name ?? o.kind ?? o.day ?? o.from;
    const url = o.url ?? o.href;
    if (main !== undefined && main !== null && main !== "") return url ? `${String(main)} (${String(url)})` : String(main);
    if (url) return String(url);
    return JSON.stringify(x);
  }
  if (Array.isArray(x)) return JSON.stringify(x);
  return String(x ?? "");
}

function entries(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.entries(v as Data).map(([k, x]) => `${k}: ${typeof x === "object" && x !== null ? JSON.stringify(x) : String(x)}`);
  return [];
}

function listChange(old: unknown, now: unknown): Raw {
  const a = entries(old);
  const b = entries(now);
  const key = (x: unknown) => JSON.stringify(x);
  const had = new Set(a.map(key));
  const has = new Set(b.map(key));
  const added = b.filter((x) => !had.has(key(x))).map(entryName);
  const removed = a.filter((x) => !has.has(key(x))).map(entryName);
  if (!added.length && !removed.length) return html`<div class="value">Same entries, in a new order.</div>`;
  return html`${added.length ? html`<div class="value">Added: ${added.join(" · ")}</div>` : ""}${removed.length ? html`<div class="value">Removed: <span class="old">${removed.join(" · ")}</span></div>` : ""}`;
}

const scalar = (v: unknown) => (v === undefined || v === null || v === "" ? html`<span class="meta">(empty)</span>` : html`${String(v)}`);

function changeRow(kind: string, k: string, old: unknown, now: unknown): Raw {
  const label = labelFor(kind, k);
  let value: Raw;
  const isList = (v: unknown) => Array.isArray(v) || (v !== null && typeof v === "object");
  if (isList(old) || isList(now)) value = listChange(old, now);
  else if ((typeof old === "string" && media.LOCAL.test(old)) || (typeof now === "string" && media.LOCAL.test(now))) {
    value = html`<div class="value">${thumb(String(old ?? ""))} → ${thumb(String(now ?? ""))}</div>`;
  } else {
    const o = old === undefined || old === null ? "" : String(old);
    const n = now === undefined || now === null ? "" : String(now);
    if (o && n && (k === "body" || k === "about" || o.length > LONG || n.length > LONG)) value = diffHtml(o, n);
    else value = html`<div class="value">${o ? html`<span class="old">${o}</span>` : scalar(o)} → ${scalar(n)}</div>`;
  }
  const raise =
    kind === "card" && k === "visibility" && (RANK[String(now ?? "public")] ?? 2) > (RANK[String(old ?? "public")] ?? 2)
      ? html`<p class="warn">Shows more of this card than your site does now.</p>`
      : "";
  return html`<div class="field"><b>${label}</b>${value}${raise}</div>`;
}

/**
 * "What changed": one row per field that differs from the live version, plus
 * any extra rows (an address change). Unchanged fields are counted, not shown.
 */
export function whatChanged(kind: string, now: Data, before: Data, extra: Raw[] = []): Raw {
  // With defaults filled in, a field one version leaves out and the other
  // stores at its default isn't a change. Data that no longer validates is compared as stored.
  const full = (d: Data): Data => {
    try {
      return validate(kind, d);
    } catch (e) {
      if (e instanceof ApiError) return d;
      throw e;
    }
  };
  now = full(now);
  before = full(before);
  const keys = [...Object.keys(now), ...Object.keys(before).filter((k) => !(k in now))];
  const rows: Raw[] = [...extra];
  let unchanged = 0;
  for (const k of keys) {
    if (same(before[k], now[k])) {
      if (!SILENT.has(k)) unchanged++;
      continue;
    }
    rows.push(changeRow(kind, k, before[k], now[k]));
  }
  return html`<details class="changed" open><summary class="meta" style="cursor:pointer">What changed</summary>${
    rows.length ? rows : html`<p class="meta">Nothing you would see differs from what is live.</p>`
  }${unchanged ? html`<p class="meta">${String(unchanged)} other field${unchanged === 1 ? "" : "s"} unchanged</p>` : ""}</details>`;
}

/** The address row for an entry whose page moves. */
export function addressRow(from: string, to: string): Raw {
  return html`<div class="field"><b>Address</b><p>Address changes from ${from} to ${to}</p></div>`;
}

export function takenOff(label: string): Raw {
  return html`<p>This will be taken off the site: <b>${label}</b></p>`;
}

/** The owner's styles for the above (part of OWNER_CSS). */
export const CHANGES_CSS = ".diff del{background:#f3dcd6;color:var(--deny)}.diff ins{background:#dcefe4;color:#1f4034;text-decoration:none}.field .warn{margin:6px 0 0}";
