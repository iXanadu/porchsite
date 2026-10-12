// Visitor analytics (spec §8): first-party, nothing that identifies a person.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as analytics from "../src/analytics";
import { BEACON_JS } from "../src/beacon";
import type { Env } from "../src/env";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;
const at = (path: string, init?: RequestInit) => handle(new Request(`https://site.example${path}`, init), e);

const UA = "Mozilla/5.0 (test reader)";
const D = "2026-10-12";
const T = (hms: string, day = D) => new Date(`${day}T${hms}Z`);
const send = (ev: Record<string, unknown>, now: Date, ip = "192.0.2.10", extra: Partial<analytics.Visit> = {}) =>
  analytics.collect(db, JSON.stringify(ev), { ip, ua: UA, notrack: false, host: "site.example", now, ...extra });

async function signedIn(): Promise<string> {
  const token = "analytics-test-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await db.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

describe("analytics", () => {
  it("records a page view and its heartbeats, and never the address", async () => {
    expect(await send({ t: "pv", id: "view-aaaa-0001", p: "/", k: "home", r: "https://www.google.com/search" }, T("12:00:00"))).toBe(true);
    expect(await send({ t: "hb", id: "view-aaaa-0001", e: 30000, d: 100 }, T("12:00:40"))).toBe(true);
    const row = await db.prepare("SELECT * FROM pageviews WHERE id = 'view-aaaa-0001'").first<Record<string, unknown>>();
    expect(row).toMatchObject({ day: D, path: "/", kind: "home", ref_bucket: "search", ref_domain: "google.com", engaged_ms: 30000, max_scroll: 100, test: 0 });
    expect(String(row!.visitor)).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain("192.0.2.10");
    // A replayed view counts once; engaged time never passes wall time since the view.
    expect(await send({ t: "pv", id: "view-aaaa-0001", p: "/", k: "home" }, T("12:00:41"))).toBe(false);
    expect(await send({ t: "pv", id: "view-wall-0001", p: "/x/" }, T("12:00:00"))).toBe(true);
    expect(await send({ t: "hb", id: "view-wall-0001", e: 4 * 3600 * 1000, d: 10 }, T("12:00:10"))).toBe(true);
    expect(await db.prepare("SELECT engaged_ms, max_scroll FROM pageviews WHERE id = 'view-wall-0001'").first()).toEqual({ engaged_ms: 15000, max_scroll: 10 });
    // Nor after six hours.
    expect(await send({ t: "hb", id: "view-wall-0001", e: 1000 }, T("18:00:01"))).toBe(false);
    await db.prepare("DELETE FROM pageviews WHERE id = 'view-wall-0001'").run();
  });

  it("leaves out bots, the owner, owner pages and anything malformed", async () => {
    const now = T("12:00:05");
    expect(await send({ t: "pv", id: "view-bot-00001", p: "/" }, now, "192.0.2.10", { ua: "Googlebot/2.1" })).toBe(false);
    expect(await send({ t: "pv", id: "view-bot-00002", p: "/" }, now, "192.0.2.10", { ua: "" })).toBe(false);
    expect(await send({ t: "pv", id: "view-own-00001", p: "/" }, now, "192.0.2.10", { notrack: true })).toBe(false);
    expect(await send({ t: "pv", id: "view-rev-00001", p: "/review/abc" }, now)).toBe(false);
    expect(await send({ t: "pv", id: "short", p: "/" }, now)).toBe(false);
    expect(await send({ t: "pv", id: "view-big-00001", p: `/${"x".repeat(3000)}` }, now)).toBe(false);
    expect(await analytics.collect(db, "not json", { ip: "192.0.2.10", ua: UA, notrack: false, host: "site.example", now })).toBe(false);
    expect(await send({ t: "hb", id: "view-none-0001", e: 1000 }, now)).toBe(false);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM pageviews").first<{ n: number }>())!.n).toBe(1);
  });

  it("makes one visitor per day, and forgets the day's salt once it's over", async () => {
    await send({ t: "pv", id: "view-aaaa-0002", p: "/journal/tea/", k: "entry", c: "ent_aaaa1111", r: "https://site.example/" }, T("12:01:00"));
    await send({ t: "hb", id: "view-aaaa-0002", e: 60000, d: 50 }, T("12:02:30"));
    const same = await db.prepare("SELECT COUNT(DISTINCT visitor) AS n FROM pageviews WHERE day = ?").bind(D).first<{ n: number }>();
    expect(same!.n).toBe(1);
    expect((await db.prepare("SELECT prev_path, ref_bucket FROM pageviews WHERE id = 'view-aaaa-0002'").first())).toEqual({ prev_path: "/", ref_bucket: "internal" });
    await send({ t: "pv", id: "view-next-0001", p: "/", k: "home" }, T("09:00:00", "2026-10-13"));
    const days = await db.prepare("SELECT day FROM analytics_salts ORDER BY day").all<{ day: string }>();
    expect(days.results.map((r) => r.day)).toEqual(["2026-10-13"]);
    const two = await db.prepare("SELECT visitor FROM pageviews WHERE id IN ('view-aaaa-0002', 'view-next-0001')").all<{ visitor: string }>();
    expect(new Set(two.results.map((r) => r.visitor)).size).toBe(2);
    await db.prepare("DELETE FROM pageviews WHERE id = 'view-next-0001'").run();
  });

  it("reports visits, pages, sources and tagged links", async () => {
    await send({ t: "pv", id: "view-bbbb-0001", p: "/journal/tea/", k: "entry", c: "ent_aaaa1111", r: "", s: "X", q: "p1" }, T("12:05:00"), "198.51.100.7");
    await send({ t: "hb", id: "view-bbbb-0001", e: 5000, d: 25 }, T("12:05:10"));
    await send({ t: "pv", id: "view-test-0001", p: "/", k: "home", w: 1 }, T("12:06:00"), "198.51.100.9");
    const s = (await analytics.stats(db, { days: 7, now: T("18:00:00") })) as any;
    expect(s.range).toEqual({ start: "2026-10-06", end: D });
    expect(s.totals).toEqual({ visits: 2, views: 3, engaged_ms: 95000, median_visit_engaged_ms: 47500, bounce_rate: 50, multi_page_rate: 50 });
    expect(s.daily).toEqual([{ day: D, visits: 2, views: 3, engaged_ms: 95000 }]);
    expect(s.pages).toEqual([
      { path: "/journal/tea/", kind: "entry", content_id: "ent_aaaa1111", title: null, readers: 2, views: 2, median_engaged_ms: 32500, mean_engaged_ms: 32500, reached: { "25": 100, "50": 50, "75": 0, "100": 0 }, landings: 1, bounce_rate: 100, exits: 2 },
      { path: "/", kind: "home", content_id: null, title: null, readers: 1, views: 1, median_engaged_ms: 30000, mean_engaged_ms: 30000, reached: { "25": 100, "50": 100, "75": 100, "100": 100 }, landings: 1, bounce_rate: 0, exits: 0 },
    ]);
    expect(s.sources).toEqual([{ source: "search", visits: 1, engaged_ms: 90000 }, { source: "x", visits: 1, engaged_ms: 5000 }]);
    expect(s.referring_domains).toEqual([{ domain: "google.com", visits: 1 }]);
    expect(s.tagged).toEqual([{ src: "x", post: "p1", visits: 1, visit_engaged_ms: 5000 }]);
    expect(((await analytics.stats(db, { days: 7, now: T("18:00:00"), include_test: true })) as any).totals.visits).toBe(3);
    const one = (await analytics.stats(db, { days: 7, now: T("18:00:00"), src: "x" })) as any;
    expect(one.totals).toMatchObject({ visits: 1, views: 1 });
    expect(one.filter).toEqual({ content_id: null, src: "x", post: null, include_test: false });
    expect(analytics.pct(1, 3)).toBe(33.3);
    expect(analytics.pct(2, 3)).toBe(66.7);
  });

  it("serves the beacon from the kit and takes its events at /collect", async () => {
    const js = await at("/static/a.js");
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const text = await js.text();
    expect(text).toBe(BEACON_JS);
    expect(text).toContain('navigator.sendBeacon("/collect"');
    const body = JSON.stringify({ t: "pv", id: "view-http-0001", p: "/", k: "home" });
    const r = await at("/collect", { method: "POST", body, headers: { "user-agent": UA, "cf-connecting-ip": "192.0.2.20" } });
    expect(r.status).toBe(204);
    expect(await db.prepare("SELECT 1 AS y FROM pageviews WHERE id = 'view-http-0001'").first()).toEqual({ y: 1 });
    const owner = await at("/collect", { method: "POST", body: body.replace("0001", "0002"), headers: { "user-agent": UA, Cookie: "sk_nt=1" } });
    expect(owner.status).toBe(204);
    expect(await db.prepare("SELECT 1 FROM pageviews WHERE id = 'view-http-0002'").first()).toBeNull();
  });

  it("shows the owner the numbers, and leaves their browser out", async () => {
    await db.prepare("DELETE FROM pageviews WHERE id = 'view-http-0001'").run();
    await db.prepare("UPDATE pageviews SET day = ? WHERE day = ?").bind(analytics.localDay(new Date(), "UTC"), D).run();
    const cookie = await signedIn();
    const page = await at("/review/stats?days=7", { headers: { Cookie: cookie } });
    expect(page.headers.getSetCookie()).toContain(analytics.NOTRACK_SET);
    const text = await page.text();
    for (const part of [
      "<h1>Who's reading</h1>",
      '<a class="range on" href="/review/stats?days=7">7 days</a>',
      '<div class="stat"><b>2</b><span>visitors</span></div>',
      '<div class="stat"><b>3</b><span>pages read</span></div>',
      '<div class="stat"><b>48s</b><span>typical stay</span></div>',
      '<div class="stat"><b>50%</b><span>left right away</span></div>',
      '<div class="meta">entry · /journal/tea/</div>',
      "<span>2 readers</span><span>typical 33s</span><span>avg 33s</span><span>100% left right away</span>",
      '<span class="drop-num">50%</span>',
      "<span>Search</span><span>1 · 1m 30s</span>",
      '<div class="row sub-row"><span>google.com</span><span>1</span></div>',
      "<span>x · p1</span><span>1 · 5s</span>",
    ]) {
      expect(text, part).toContain(part);
    }
    expect((await at("/review/stats")).status).toBe(303);
    expect(analytics.NOTRACK_SET).toBe("sk_nt=1; Path=/collect; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000");
  });
});
