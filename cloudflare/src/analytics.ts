/**
 * First-party visitor analytics (SPEC §8): collect page views, report on them.
 *
 * Nothing here identifies a person. A visitor is sha256(salt + IP + user
 * agent) where the salt is random, belongs to one day, and is deleted once the
 * day is over, so yesterday's hashes can't be recomputed and the same reader on
 * two days is two visitors. The IP itself is never stored.
 *
 * The beacon (/static/a.js, beacon.ts) sends two events, as JSON:
 *   {"t": "pv", "id", "p" path, "k" kind, "c" content id, "r" referrer,
 *    "s" src, "q" post, "w" test}            one per page view
 *   {"t": "hb", "id", "e" engaged ms, "d" scroll %}   heartbeats and the final send
 *
 * Counting rules:
 * - A visit is one visitor on one day. "Readers" of a page = visits that viewed it.
 * - Engaged time counts only while the tab is visible and the reader was active
 *   in the last 30 seconds (the beacon measures it).
 * - Bounce: a visit with under 10 s engaged in total, or one page with no
 *   scroll past 25%.
 * - Not counted: the owner (the not-tracked cookie, set when they sign in, or
 *   the beacon's own opt-out), bots by user agent, and anything that never ran
 *   JS. Test visits (an assistant's checks, automated browsers) are kept but
 *   marked, and only show when asked for.
 *
 * Every number is worked out here from the raw rows, the same way in both
 * editions (server/server/app/analytics.py).
 */
import { dateFormatter } from "./date-format";
import { siteData } from "./content";

export const NOTRACK_COOKIE = "sk_nt";
export const RETAIN_DAYS = 90;
const MAX_BODY = 2048;
const MAX_ENGAGED_MS = 4 * 3600 * 1000;
export const BOUNCE_MS = 10_000;

const KINDS = new Set(["home", "entry", "archive", "tag", "notfound", "other"]);
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const SRC = /^[a-z0-9_-]{1,20}$/;
const POST = /^[A-Za-z0-9_-]{1,40}$/;
const CONTENT = /^[a-z]{2,8}_[A-Za-z0-9]{4,40}$/;
const BOT =
  /bot|crawl|spider|slurp|headless|phantom|lighthouse|pagespeed|preview|scanner|facebookexternalhit|embedly|quora link|outbrain|pinterest\/|vkshare|w3c_validator|curl|wget|python-|httpx|go-http|java\/|okhttp|axios|node-fetch|monitor|uptime/i;
const SEARCH = ["google.", "bing.com", "duckduckgo.com", "search.yahoo.", "yandex.", "ecosia.org", "search.brave.com", "baidu.com", "kagi.com", "startpage.com"];
const X = ["t.co", "x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"];

/** The not-tracked cookie, set on the collect path only, for about 400 days. */
export const NOTRACK_SET = `${NOTRACK_COOKIE}=1; Path=/collect; HttpOnly; Secure; SameSite=Lax; Max-Age=${400 * 86400}`;

export const isBot = (ua: string): boolean => !ua || BOT.test(ua);

/** YYYY-MM-DD on the site's clock. */
export function localDay(now: Date, tz: string): string {
  const p = dateFormatter({ year: "numeric", month: "2-digit", day: "2-digit" }, tz).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function today(db: D1Database, now: Date): Promise<string> {
  return localDay(now, String((await siteData(db, true)).timezone || "UTC"));
}

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function salt(db: D1Database, day: string): Promise<string> {
  await db.prepare("INSERT OR IGNORE INTO analytics_salts (day, salt) VALUES (?, ?)").bind(day, hex(crypto.getRandomValues(new Uint8Array(32)))).run();
  return (await db.prepare("SELECT salt FROM analytics_salts WHERE day = ?").bind(day).first<{ salt: string }>())!.salt;
}

export async function visitorHash(db: D1Database, day: string, ip: string, ua: string): Promise<string> {
  const s = await salt(db, day);
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${s}${ip}\n${ua}`))).slice(0, 32);
}

/** [bucket, domain, previous path on this site] for a document.referrer. */
export function referrer(ref: string, host: string): [string, string, string] {
  if (!ref) return ["direct", "", ""];
  let u: URL;
  try {
    u = new URL(ref);
  } catch {
    return ["other", "", ""];
  }
  const domain = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!domain) return ["direct", "", ""];
  if (domain === host.toLowerCase().replace(/^www\./, "")) return ["internal", "", (u.pathname || "/").slice(0, 300)];
  if (X.includes(domain)) return ["x", domain, ""];
  if (SEARCH.some((s) => domain.startsWith(s) || `.${domain}`.includes(`.${s}`))) return ["search", domain, ""];
  return ["other", domain.slice(0, 100), ""];
}

const str = (v: unknown, limit: number) => (typeof v === "string" ? v.slice(0, limit) : "");
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);

export interface Visit {
  ip: string;
  ua: string;
  notrack: boolean;
  host: string;
  now?: Date;
}

/**
 * Record one beacon event. Returns whether it was recorded; never throws for
 * bad input (the beacon can't do anything with an error).
 */
export async function collect(db: D1Database, raw: string, v: Visit): Promise<boolean> {
  if (new TextEncoder().encode(raw).length > MAX_BODY || v.notrack) return false;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!ev || typeof ev !== "object" || Array.isArray(ev) || typeof ev.id !== "string" || !ID.test(ev.id)) return false;
  const now = v.now ?? new Date();
  const at = now.toISOString();
  if (ev.t === "pv") {
    // Bots are stopped here; a heartbeat only ever updates a view that got in.
    if (isBot(v.ua)) return false;
    const path = str(ev.p, 300);
    if (!path.startsWith("/") || /^\/(review|mcp|collect)/.test(path)) return false;
    const day = await today(db, now);
    // Yesterday's salts go, and views past their 90 days, their counts kept.
    const cutoff = addDays(day, -RETAIN_DAYS);
    await db.batch([
      db.prepare("DELETE FROM analytics_salts WHERE day < ?").bind(day),
      db
        .prepare(
          "INSERT OR IGNORE INTO analytics_daily (day, visits, views, engaged_ms) SELECT day, COUNT(DISTINCT visitor), COUNT(*), SUM(engaged_ms) FROM pageviews WHERE day < ? AND test = 0 GROUP BY day",
        )
        .bind(cutoff),
      db.prepare("DELETE FROM pageviews WHERE day < ?").bind(cutoff),
    ]);
    const visitor = await visitorHash(db, day, v.ip, v.ua);
    const kind = str(ev.k, 20);
    const contentId = str(ev.c, 60);
    const src = str(ev.s, 20).toLowerCase();
    const post = str(ev.q, 40);
    let [bucket, domain, prev] = referrer(str(ev.r, 500), v.host);
    // The X app often sends no referrer at all; a tagged link still says where.
    if (src === "x" && (bucket === "direct" || bucket === "other")) bucket = "x";
    const r = await db
      .prepare(
        `INSERT OR IGNORE INTO pageviews (id, day, visitor, path, kind, content_id, ref_bucket, ref_domain, prev_path, src, post, test, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ev.id as string,
        day,
        visitor,
        path,
        KINDS.has(kind) ? kind : "other",
        CONTENT.test(contentId) ? contentId : "",
        bucket,
        domain,
        prev,
        SRC.test(src) ? src : "",
        src && POST.test(post) ? post : "",
        ev.w === 1 || ev.w === true ? 1 : 0,
        at,
        at,
      )
      .run();
    return r.meta.changes === 1;
  }
  if (ev.t === "hb") {
    const engaged = Math.max(0, Math.min(int(ev.e), MAX_ENGAGED_MS));
    const scroll = Math.max(0, Math.min(int(ev.d), 100));
    // Matched on the page view's id alone: it is random and only the reader's
    // browser knows it, and a phone that moves from Wi-Fi to cellular mid-read
    // has a new address. Never more engaged time than wall time since the view
    // began (plus slack for clock skew).
    const since = new Date(now.getTime() - 6 * 3600 * 1000).toISOString();
    const row = await db
      .prepare("SELECT created_at, engaged_ms, max_scroll FROM pageviews WHERE id = ? AND created_at > ?")
      .bind(ev.id as string, since)
      .first<{ created_at: string; engaged_ms: number; max_scroll: number }>();
    if (!row) return false;
    const wall = now.getTime() - new Date(row.created_at).getTime() + 5000;
    // Compare against the current row in SQL: overlapping requests may both
    // have read the same older snapshot. A no-progress heartbeat is accepted
    // without a write (including an updated_at-only write).
    await db
      .prepare("UPDATE pageviews SET engaged_ms = MAX(engaged_ms, ?), max_scroll = MAX(max_scroll, ?), updated_at = ? WHERE id = ? AND (engaged_ms < ? OR max_scroll < ?)")
      .bind(Math.min(engaged, wall), scroll, at, ev.id as string, Math.min(engaged, wall), scroll)
      .run();
    return true;
  }
  return false;
}

// --- reports ---------------------------------------------------------------------

interface View {
  id: string;
  day: string;
  visitor: string;
  path: string;
  kind: string;
  content_id: string;
  ref_bucket: string;
  ref_domain: string;
  src: string;
  post: string;
  engaged_ms: number;
  max_scroll: number;
  created_at: string;
}

/** 100 * n / d to one decimal, halves up; 0 when d is 0. */
export const pct = (n: number, d: number): number => (d ? Math.floor((2000 * n + d) / (2 * d)) / 10 : 0);

/** The middle value (the mean of the two middle ones for an even count), as PERCENTILE_CONT(0.5). */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface StatsQuery {
  days?: number;
  content_id?: string | null;
  src?: string | null;
  post?: string | null;
  include_test?: boolean;
  top?: number;
  now?: Date;
}

/** Everything the /review/stats page and the site_stats tool show. */
export async function stats(db: D1Database, q: StatsQuery = {}): Promise<Record<string, unknown>> {
  const days = Math.max(1, Math.min(Math.trunc(q.days ?? 7), RETAIN_DAYS));
  const end = await today(db, q.now ?? new Date());
  const start = addDays(end, -(days - 1));
  const includeTest = !!q.include_test;
  const top = q.top ?? 20;
  const { results } = await db
    .prepare(`SELECT * FROM pageviews WHERE day BETWEEN ? AND ?${includeTest ? "" : " AND test = 0"} ORDER BY created_at, id`)
    .bind(start, end)
    .all<View>();
  let rows: View[] = results;
  const key = (r: View) => `${r.day} ${r.visitor}`;
  // Narrowing to one entry or one tagged post: the visits that touched it.
  if (q.content_id || q.src || q.post) {
    const keep = new Set(
      rows.filter((r) => (!q.content_id || r.content_id === q.content_id) && (!q.src || r.src === q.src) && (!q.post || r.post === q.post)).map(key),
    );
    rows = rows.filter((r) => keep.has(key(r)));
  }

  interface V {
    day: string;
    pages: number;
    engaged: number;
    scroll: number;
    landing: string;
    ref: string;
    domain: string;
    exit: string;
    tags: Set<string>;
  }
  const visits = new Map<string, V>();
  for (const r of rows) {
    const k = key(r);
    let v = visits.get(k);
    if (!v) {
      v = { day: r.day, pages: 0, engaged: 0, scroll: 0, landing: r.path, ref: r.ref_bucket, domain: r.ref_domain, exit: r.path, tags: new Set() };
      visits.set(k, v);
    }
    v.pages += 1;
    v.engaged += r.engaged_ms;
    v.scroll = Math.max(v.scroll, r.max_scroll);
    v.exit = r.path;
    if (r.src) v.tags.add(`${r.src}\n${r.post}`);
  }
  const all = [...visits.values()];
  const bounced = (v: V) => v.engaged < BOUNCE_MS || (v.pages === 1 && v.scroll < 25);

  const byDay = new Map<string, V[]>();
  for (const v of all) byDay.set(v.day, [...(byDay.get(v.day) ?? []), v]);
  const daily = [...byDay.keys()].sort(cmp).map((d) => {
    const vs = byDay.get(d)!;
    return { day: d, visits: vs.length, views: sum(vs.map((v) => v.pages)), engaged_ms: sum(vs.map((v) => v.engaged)) };
  });

  const landing = new Map<string, { visits: number; bounces: number }>();
  const exits = new Map<string, number>();
  for (const v of all) {
    const l = landing.get(v.landing) ?? { visits: 0, bounces: 0 };
    l.visits += 1;
    if (bounced(v)) l.bounces += 1;
    landing.set(v.landing, l);
    exits.set(v.exit, (exits.get(v.exit) ?? 0) + 1);
  }

  const byPath = new Map<string, View[]>();
  for (const r of rows) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
  const pageRows = [...byPath.entries()]
    .map(([path, rs]) => ({ path, rs, readers: new Set(rs.map(key)).size }))
    .sort((a, b) => b.readers - a.readers || b.rs.length - a.rs.length || cmp(a.path, b.path))
    .slice(0, top);
  const ids = [...new Set(pageRows.map((p) => p.rs.reduce((m, r) => (r.content_id > m ? r.content_id : m), "")).filter(Boolean))];
  const titles = new Map<string, string>();
  for (const id of ids) {
    const row = await db.prepare("SELECT data FROM items WHERE id = ?").bind(id).first<{ data: string }>();
    if (row) {
      const d = JSON.parse(row.data);
      titles.set(id, String(d.title ?? d.name ?? ""));
    }
  }
  const reached = (rs: View[], k: number) => pct(rs.filter((r) => r.max_scroll >= k).length, rs.length);
  const pages = pageRows.map(({ path, rs, readers }) => {
    const contentId = rs.reduce((m, r) => (r.content_id > m ? r.content_id : m), "");
    const l = landing.get(path);
    return {
      path,
      kind: rs.reduce((m, r) => (r.kind > m ? r.kind : m), ""),
      content_id: contentId || null,
      title: titles.get(contentId) ?? null,
      readers,
      views: rs.length,
      median_engaged_ms: Math.trunc(median(rs.map((r) => r.engaged_ms))),
      mean_engaged_ms: Math.trunc(sum(rs.map((r) => r.engaged_ms)) / rs.length),
      reached: { "25": reached(rs, 25), "50": reached(rs, 50), "75": reached(rs, 75), "100": reached(rs, 100) },
      landings: l ? l.visits : 0,
      bounce_rate: l ? pct(l.bounces, l.visits) : null,
      exits: exits.get(path) ?? 0,
    };
  });

  const bySource = new Map<string, V[]>();
  for (const v of all) bySource.set(v.ref, [...(bySource.get(v.ref) ?? []), v]);
  const sources = [...bySource.entries()]
    .map(([source, vs]) => ({ source, visits: vs.length, engaged_ms: sum(vs.map((v) => v.engaged)) }))
    .sort((a, b) => b.visits - a.visits || cmp(a.source, b.source));
  const byDomain = new Map<string, number>();
  for (const v of all) if (v.domain) byDomain.set(v.domain, (byDomain.get(v.domain) ?? 0) + 1);
  const referring = [...byDomain.entries()]
    .map(([domain, n]) => ({ domain, visits: n }))
    .sort((a, b) => b.visits - a.visits || cmp(a.domain, b.domain))
    .slice(0, 15);
  const byTag = new Map<string, V[]>();
  for (const v of all) for (const t of v.tags) byTag.set(t, [...(byTag.get(t) ?? []), v]);
  const tagged = [...byTag.entries()]
    .map(([t, vs]) => {
      const [src, post] = t.split("\n");
      return { src, post: post || null, visits: vs.length, visit_engaged_ms: sum(vs.map((v) => v.engaged)) };
    })
    .sort((a, b) => b.visits - a.visits || cmp(a.src, b.src) || cmp(a.post ?? "", b.post ?? ""))
    .slice(0, 30);

  // Earlier, counts only: days past their 90 days, by month, newest first (the whole site only).
  const earlier: { month: string; visits: number; views: number; engaged_ms: number }[] = [];
  if (!q.content_id && !q.src && !q.post) {
    const { results: old } = await db
      .prepare("SELECT substr(day, 1, 7) AS month, SUM(visits) AS visits, SUM(views) AS views, SUM(engaged_ms) AS engaged_ms FROM analytics_daily GROUP BY month ORDER BY month DESC")
      .all<{ month: string; visits: number; views: number; engaged_ms: number }>();
    earlier.push(...old.map((r) => ({ month: r.month, visits: Number(r.visits), views: Number(r.views), engaged_ms: Number(r.engaged_ms) })));
  }

  return {
    range: { start, end },
    filter: { content_id: q.content_id ?? null, src: q.src ?? null, post: q.post ?? null, include_test: includeTest },
    notes: `A visit = one visitor on one day (visitors are not linked across days). Engaged time counts only while the page is visible and the reader is active. Bounce = under ${BOUNCE_MS / 1000} s engaged, or one page with no scroll past 25%. The owner, bots and test runs are not counted. Time on page and scroll can lag up to a minute while someone is still reading. Browser or connection delays can make that longer. If the final message is lost, recorded time and scroll can be lower.`,
    totals: {
      visits: all.length,
      views: sum(all.map((v) => v.pages)),
      engaged_ms: sum(all.map((v) => v.engaged)),
      median_visit_engaged_ms: Math.trunc(median(all.map((v) => v.engaged))),
      bounce_rate: pct(all.filter(bounced).length, all.length),
      multi_page_rate: pct(all.filter((v) => v.pages > 1).length, all.length),
    },
    daily,
    pages,
    sources,
    referring_domains: referring,
    tagged,
    earlier,
  };
}
