// Port-matched: server/tests/app/test_analytics_admission.py.
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { collect, stats, visitorHash } from "../src/analytics";
import type { Env } from "../src/env";
const db = (env as unknown as Env).DB, day = "2026-10-18", ua = "Mozilla/5.0 reader";
const at = new Date(day + "T12:00:00Z");
const send = (id: string, extra: Record<string, unknown> = {}, database = db, now = at) => collect(database, JSON.stringify({ t: "pv", id, p: "/", ...extra }), { ip: "192.0.2.10", ua, notrack: false, host: "site.example", now });
const count = () => db.prepare("SELECT COUNT(*) AS n FROM pageviews").first<number>("n");
async function seed(n: number) {
  const visitor = await visitorHash(db, day, "192.0.2.10", ua);
  await db.batch(Array.from({ length: n }, (_, i) => db.prepare("INSERT INTO pageviews (id,day,visitor,path,kind,ref_bucket,created_at,updated_at) VALUES (?,?,?,'/','home','direct',?,?)").bind(`seed-view-${i}`, day, visitor, at.toISOString(), at.toISOString())));
}
beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM pageviews"), db.prepare("DELETE FROM analytics_salts"), db.prepare("DELETE FROM analytics_daily"), db.prepare("UPDATE analytics_maintenance SET completed_day = '' WHERE id = 1")]);
});
it("admits exactly the final slot under contention, including test views, and retains admitted heartbeats", async () => {
  await seed(199);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => send(`final-slot-${i}`, { w: i % 2 })));
  expect(results.filter(Boolean)).toHaveLength(1); expect(await count()).toBe(200);
  const winner = results.indexOf(true), loser = results.indexOf(false);
  expect(await send(`final-slot-${winner}`)).toBe(false);
  expect(await send("above-cap-view", { day: "2099-01-01", visitor: "fake", cap: 999 })).toBe(false);
  expect(await send(`final-slot-${winner}`, { t: "hb", e: 1000, d: 25 }, db, new Date(+at + 10000))).toBe(true);
  expect(await send(`final-slot-${loser}`, { t: "hb", e: 1000, d: 25 })).toBe(false);
  expect((await stats(db, { now: at })).notes).toContain("At most 200 page views per visitor per day are recorded; additional page views are omitted.");
});
it("counts over-cap historical rows without rewriting them, and permits a new daily identity", async () => {
  await seed(201); expect(await send("old-history-new")).toBe(false); expect(await count()).toBe(201);
  expect(await send("next-day-new", {}, db, new Date("2026-10-19T12:00:00Z"))).toBe(true);
  expect(await count()).toBe(202);
});
it("does no new database work for invalid ids, opt-outs, bots, excluded paths or malformed payloads", async () => {
  let calls = 0;
  const fail = new Proxy(db, { get() { calls++; throw new Error("unexpected database use"); } });
  expect(await send("short", {}, fail)).toBe(false);
  expect(await send("excluded-path", { p: "/review/" }, fail)).toBe(false);
  for (const opts of [{ notrack: true, ua }, { notrack: false, ua: "bot" }]) expect(await collect(fail, '{"t":"pv","id":"valid-id-01","p":"/"}', { ip: "192.0.2.10", host: "site.example", ...opts })).toBe(false);
  expect(await collect(fail, "{", { ip: "", ua, notrack: false, host: "site.example" })).toBe(false);
  expect(calls).toBe(0);
});
async function expired() {
  await db.prepare("INSERT INTO pageviews (id,day,visitor,path,kind,ref_bucket,engaged_ms,created_at,updated_at) VALUES ('expired-view','2026-01-01','old','/','home','direct',1000,'2026-01-01','2026-01-01')").run();
}
it("cleans once despite concurrent/stale readers, retains exact counts, and never lowers the watermark", async () => {
  await expired();
  const changes: number[] = [];
  const observed = new Proxy(db, { get(target, key) {
    if (key === "batch") return async (ss: D1PreparedStatement[]) => { const rs = await target.batch(ss); changes.push(rs[3].meta.changes); return rs; };
    const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v;
  } });
  await Promise.all(Array.from({ length: 8 }, (_, i) => send(`cleanup-race-${i}`, {}, observed)));
  expect(changes.reduce((a, b) => a + b, 0)).toBe(1);
  expect((await db.prepare("SELECT * FROM analytics_daily").all()).results).toEqual([{ day: "2026-01-01", visits: 1, views: 1, engaged_ms: 1000 }]);
  await expired(); await send("same-day-view");
  expect(await db.prepare("SELECT id FROM pageviews WHERE id = 'expired-view'").first()).not.toBeNull();
  await send("backwards-view", {}, db, new Date("2026-10-17T12:00:00Z"));
  expect(await db.prepare("SELECT completed_day FROM analytics_maintenance WHERE id = 1").first("completed_day")).toBe(day);
  await send("later-day-view", {}, db, new Date("2026-10-19T12:00:00Z"));
  expect(await db.prepare("SELECT id FROM pageviews WHERE id = 'expired-view'").first()).toBeNull();
});
it("rolls back cleanup at every statement and never fails open on storage errors", async () => {
  for (let i = 0; i < 4; i++) {
    await db.prepare("DELETE FROM pageviews").run(); await expired();
    const fault = new Proxy(db, { get(target, key) {
      if (key === "batch") return (ss: D1PreparedStatement[]) => target.batch(ss.map((s, j) => i === j ? target.prepare("INSERT INTO missing_analytics_table VALUES (1)") : s));
      const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v;
    } });
    expect(await send(`failed-cleanup-${i}`, {}, fault)).toBe(false);
    expect(await count()).toBe(1);
    expect(await db.prepare("SELECT completed_day FROM analytics_maintenance WHERE id = 1").first("completed_day")).toBe("");
    expect((await db.prepare("SELECT * FROM analytics_daily").all()).results).toEqual([]);
  }
});
