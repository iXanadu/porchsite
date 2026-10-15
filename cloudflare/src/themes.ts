/**
 * Where a site's themes come from: the built-in ones bundled with this
 * release, and ones the assistant installed from the Sitekeeper catalog.
 * Installs come only from the catalog (a theme carries scripts, and the
 * catalog's themes are reviewed), checked against the catalog's sha256.
 */
import { siteData } from "./content";
import { ApiError } from "./errors";
import { HOME } from "./home";
import { LOCAL, sizeOf } from "./media";
import { check as checkTheme } from "./themecheck";
import { THEMES } from "./themes.gen";

export type Theme = {
  manifest: Record<string, any>;
  pages: Record<string, string>;
  partials: Record<string, string>;
  static: Record<string, string>;
};
export type Fetcher = (url: string) => Promise<Response>;

export const CATALOG_URL = `${HOME}/themes.json`;
const PAGES = ["home", "entry", "archive", "tag", "not_found"];
const MAX_BYTES = 1_000_000;

const cache = new Map<string, Theme>();

/** Old names of built-in themes, so sites set before a rename keep their look. */
export const ALIASES: Record<string, string> = { classic: "personal-homepage", broadsheet: "product-page" };

/** A bundled look is available without a database lookup (installed overrides remain valid looks). */
export function isBuiltIn(asked: string): boolean {
  const name = Object.hasOwn(ALIASES, asked) ? ALIASES[asked] : asked;
  return Object.hasOwn(THEMES, name);
}

/** A theme by name: installed first (it may be newer), then built-in. */
export async function load(db: D1Database, asked: string): Promise<Theme | null> {
  const name = ALIASES[asked] ?? asked;
  const row = await db.prepare("SELECT version, package FROM themes WHERE name = ?").bind(name).first<{ version: string; package: string }>();
  if (!row) return THEMES[name] ?? null;
  const key = `${name}@${row.version}`;
  let t = cache.get(key);
  if (!t) {
    t = JSON.parse(row.package) as Theme;
    cache.set(key, t);
  }
  return t;
}

export async function installed(db: D1Database): Promise<{ name: string; version: string; source: string }[]> {
  const { results } = await db.prepare("SELECT name, version, source FROM themes ORDER BY name").all<{ name: string; version: string; source: string }>();
  const mine = new Map(results.map((r) => [r.name, r]));
  const out = Object.entries(THEMES).map(([name, t]) => ({ name, version: String(t.manifest.version), source: mine.has(name) ? "installed" : "built-in" }));
  for (const o of out) if (mine.has(o.name)) o.version = mine.get(o.name)!.version;
  for (const [name, r] of mine) if (!(name in THEMES)) out.push({ name, version: r.version, source: r.source === "private" ? "private" : "installed" });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function catalog(fetcher: Fetcher = fetch): Promise<Record<string, any>[]> {
  let r: Response;
  try {
    r = await fetcher(CATALOG_URL);
  } catch {
    throw new ApiError(502, "catalog_unreachable", "The theme catalog didn't answer. Try again in a minute.");
  }
  if (!r.ok) throw new ApiError(502, "catalog_unreachable", `The theme catalog answered ${r.status}. Try again in a minute.`);
  const body = (await r.json()) as { themes?: Record<string, any>[] };
  return body.themes ?? [];
}

/** The catalog as theme_list shows it: no slots or package, the number of image slots, and author_x when the look is credited. */
export function listing(entries: Record<string, any>[]): Record<string, unknown>[] {
  return entries.map(({ slots, package: _p, author, ...t }) => {
    const x = author && typeof author === "object" ? author.x : undefined;
    return { ...t, needs_images: (slots?.images ?? []).length, ...(typeof x === "string" && /^[A-Za-z0-9_]{1,15}$/.test(x) ? { author_x: x } : {}) };
  });
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Refuse anything that isn't a whole, well-formed theme. */
export function check(name: string, t: Theme, bytes: number): void {
  const bad = (why: string) => {
    throw new ApiError(422, "bad_theme", `The theme package isn't usable: ${why}.`);
  };
  if (bytes > MAX_BYTES) bad("it's larger than 1 MB");
  if (!t || typeof t !== "object" || !t.manifest || !t.pages || !t.partials || !t.static) bad("it's missing its parts");
  if (t.manifest.name !== name) bad(`it says it's ${t.manifest.name}, not ${name}`);
  for (const p of PAGES) if (typeof t.pages[p] !== "string") bad(`it has no ${p} page`);
  if (typeof t.static["site.css"] !== "string") bad("it has no site.css");
  for (const f of Object.keys(t.static)) if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(f)) bad(`it has a file named ${f}`);
  for (const group of [t.pages, t.partials, t.static]) for (const v of Object.values(group)) if (typeof v !== "string") bad("a file isn't text");
}

/** Install (or update) a theme from the catalog. */
export async function install(db: D1Database, name: string, actor: string, fetcher: Fetcher = fetch): Promise<{ name: string; version: string }> {
  const entry = (await catalog(fetcher)).find((x) => x.name === name);
  if (!entry) throw new ApiError(404, "no_such_theme", `The catalog has no theme called ${name}. theme_list shows what it has.`);
  const r = await fetcher(entry.package.url).catch(() => null);
  if (!r || !r.ok) throw new ApiError(502, "catalog_unreachable", "The theme's package didn't download. Try again in a minute.");
  const text = await r.text();
  if ((await sha256(text)) !== entry.package.sha256) {
    throw new ApiError(502, "bad_download", "The theme's package doesn't match the catalog's checksum, so it wasn't installed.");
  }
  let t: Theme;
  try {
    t = JSON.parse(text);
  } catch {
    throw new ApiError(422, "bad_theme", "The theme package isn't usable: it isn't JSON.");
  }
  check(name, t, text.length);
  const mine = await db.prepare("SELECT source FROM themes WHERE name = ?").bind(name).first<{ source: string }>();
  if (mine?.source === "private") throw new ApiError(409, "name_taken", `This site has its own look called ${name}; the catalog one can't replace it.`);
  const version = String(t.manifest.version);
  await db
    .prepare("INSERT OR REPLACE INTO themes (name, version, package, sha256, installed_at, installed_by, source) VALUES (?, ?, ?, ?, ?, ?, 'catalog')")
    .bind(name, version, text, entry.package.sha256, new Date().toISOString(), actor)
    .run();
  return { name, version };
}

// --- a look made here, for this site only ------------------------------------------

export type Made = { manifest: Record<string, any>; sample: Record<string, any>; pages: Record<string, string>; partials?: Record<string, string>; css: string };

/** Check and store a look the assistant made; nothing else sees it. */
export async function create(db: D1Database, made: Made, actor: string, fetcher: Fetcher = fetch): Promise<{ name: string; version: string }> {
  const name = String(made.manifest?.name ?? "");
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new ApiError(422, "bad_theme", "manifest.name: lowercase letters, digits and dashes.");
  if (name in THEMES || name in ALIASES) throw new ApiError(409, "name_taken", `${name} is a built-in theme's name; pick another.`);
  const listed = await catalog(fetcher).catch(() => [] as Record<string, any>[]);
  if (listed.some((x) => x.name === name)) throw new ApiError(409, "name_taken", `The catalog has a theme called ${name}; pick another.`);
  const have = await db.prepare("SELECT source FROM themes WHERE name = ?").bind(name).first<{ source: string }>();
  if (have && have.source !== "private") throw new ApiError(409, "name_taken", `This site has a catalog theme called ${name}; pick another.`);
  const t: Theme = { manifest: made.manifest, pages: made.pages ?? {}, partials: made.partials ?? {}, static: { "site.css": made.css ?? "" } };
  const text = JSON.stringify({ ...t, sample: made.sample });
  if (text.length > MAX_BYTES) throw new ApiError(422, "bad_theme", "The look is larger than 1 MB.");
  const problems = checkTheme(name, t, made.sample, { scripts: false });
  if (problems.length) throw new ApiError(422, "theme_problems", `The look isn't usable yet: ${problems.join("; ")}`);
  const version = String(t.manifest.version);
  await db
    .prepare("INSERT OR REPLACE INTO themes (name, version, package, sha256, installed_at, installed_by, source) VALUES (?, ?, ?, ?, ?, ?, 'private')")
    .bind(name, version, text, await sha256(text), new Date().toISOString(), actor)
    .run();
  cache.clear();
  return { name, version };
}

// --- what a theme needs from this site --------------------------------------------

type Slot = Record<string, any>;

function shapeOf(size: [number, number]): string {
  return size[0] === size[1] ? "square" : size[0] > size[1] ? "wide" : "tall";
}

/** Each slot the theme declares, marked against the site as it stands now (unapproved changes included). */
export async function needs(db: D1Database, t: Theme): Promise<Record<string, any>> {
  const site = await siteData(db, false);
  const slots = (t.manifest.slots ?? {}) as { images?: Slot[]; content?: Slot[] };
  const images = [];
  for (const s of slots.images ?? []) {
    const out: Slot = { ...s };
    const [kind, field] = String(s.field).split(".");
    if (kind !== "site") {
      out.status = "per item: check each one";
    } else {
      const v = String(site[field] ?? "");
      if (!v) out.status = s.need === "optional" ? "empty (optional)" : "missing";
      else {
        const m = LOCAL.exec(v);
        const got: [number, number] = m ? await sizeOf(db, m[1]) : [0, 0];
        out.has = { image: v, width: got[0], height: got[1] };
        const [w, h] = s.size as [number, number];
        const ratioOk = got[0] > 0 && Math.abs(got[0] / got[1] - w / h) <= 0.02 * (w / h);
        const bigEnough = got[0] >= w && got[1] >= h;
        out.status = !got[0] ? "filled (size unknown)" : !ratioOk ? `wrong shape: it's ${got[0]}x${got[1]} (${shapeOf(got)}), needs ${w}x${h}` : !bigEnough ? `too small: it's ${got[0]}x${got[1]}, needs at least ${w}x${h}` : "filled";
        if (s.alt && !site[String(s.alt).split(".")[1]]) out.status += "; its description is missing";
      }
    }
    images.push(out);
  }
  const content = (slots.content ?? []).map((s) => {
    const [kind, field] = String(s.field ?? "").split(".");
    if (kind !== "site") return { ...s, status: "see purpose" };
    const v = site[field];
    const filled = Array.isArray(v) ? v.length > 0 : !!String(v ?? "").trim();
    return { ...s, status: filled ? "filled" : s.need === "optional" ? "empty (optional)" : "missing" };
  });
  // Empty, the wrong shape or too small: each named in to_fix.
  const toFix = [...images, ...content].filter((x) => /^missing|wrong shape|too small/.test(String(x.status)));
  const missing = toFix.length;
  const palettes = Object.entries((t.manifest.palettes ?? {}) as Record<string, { title: string }>).map(([name, p], i) => ({ name, title: p.title, default: i === 0 }));
  const chosen = String(site.palette ?? "");
  return {
    theme: t.manifest.name,
    version: t.manifest.version,
    type: t.manifest.type ?? "",
    palettes,
    palette: palettes.some((p) => p.name === chosen) ? chosen : (palettes[0]?.name ?? ""),
    art: t.manifest.art ?? null,
    images,
    content,
    missing,
    to_fix: toFix.map((x) => `${(x as Slot).field}: ${x.status}`),
  };
}
