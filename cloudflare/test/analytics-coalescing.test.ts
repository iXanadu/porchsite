// Port-matched: server/tests/app/test_analytics_coalescing.py.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import * as analytics from "../src/analytics";
import type { Env } from "../src/env";

const db = (env as unknown as Env).DB;
const start = new Date("2026-10-15T23:59:45Z");
const send = (database: D1Database, ev: Record<string, unknown>, ms = 0) => analytics.collect(database, JSON.stringify(ev), {
  ip: "192.0.2.10", ua: "Mozilla/5.0 (reader)", notrack: false, host: "site.example", now: new Date(+start + ms),
});
const pv = (id: string) => send(db, { t: "pv", id, p: "/journal/entry/", k: "entry" });
const row = (id: string) => db.prepare("SELECT engaged_ms, max_scroll, updated_at, day FROM pageviews WHERE id = ?").bind(id).first();

// Instrument real statements, including a barrier that makes concurrent
// heartbeats read the same stale row before either UPDATE is allowed to run.
function observed(barrier = false) {
  const writes: number[] = [];
  let readers = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  function wrap(stmt: D1PreparedStatement, sql: string): D1PreparedStatement {
    return new Proxy(stmt, { get(target, key) {
      if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
      if (key === "run" && sql.startsWith("UPDATE pageviews")) return async () => {
        const result = await target.run(); writes.push(result.meta.changes); return result;
      };
      if (key === "first" && barrier && sql.startsWith("SELECT created_at")) return async () => {
        const result = await target.first();
        if (++readers === 2) release();
        await ready; return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  const database = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database, writes };
}

it("accepts duplicate/out-of-order snapshots without a write and keeps the original day", async () => {
  const id = "coalesce-view-0001"; await pv(id);
  const { database, writes } = observed();
  for (const [e, d, ms] of [[30000, 50, 40000], [30000, 50, 41000], [10000, 25, 42000], [10000, 100, 43000]]) {
    expect(await send(database, { t: "hb", id, e, d }, ms)).toBe(true);
  }
  expect(writes).toEqual([1, 0, 0, 1]);
  expect(await row(id)).toEqual({ engaged_ms: 30000, max_scroll: 100, day: "2026-10-15", updated_at: "2026-10-16T00:00:28.000Z" });
  expect(await send(database, { t: "hb", id, e: 30000, d: 100 }, 44000)).toBe(true);
  expect((await row(id))!.updated_at).toBe("2026-10-16T00:00:28.000Z");
});

it("merges concurrent cumulative maxima even when both SELECTs read the old row", async () => {
  const id = "coalesce-race-0001"; await pv(id);
  const { database, writes } = observed(true);
  expect(await Promise.all([
    send(database, { t: "hb", id, e: 40000, d: 25 }, 45000),
    send(database, { t: "hb", id, e: 10000, d: 100 }, 45000),
  ])).toEqual([true, true]);
  expect(await row(id)).toMatchObject({ engaged_ms: 40000, max_scroll: 100 });
  expect(writes).toEqual([1, 1]);
});

it("retains wall-time, four-hour engagement and six-hour acceptance bounds", async () => {
  const id = "coalesce-limits-01"; await pv(id);
  expect(await send(db, { t: "hb", id, e: 99_000_000, d: 200 }, 10000)).toBe(true);
  expect(await row(id)).toMatchObject({ engaged_ms: 15000, max_scroll: 100 });
  expect(await send(db, { t: "hb", id, e: 99_000_000, d: 200 }, 5 * 3600_000)).toBe(true);
  expect(await row(id)).toMatchObject({ engaged_ms: 4 * 3600_000, max_scroll: 100 });
  expect(await send(db, { t: "hb", id, e: 1 }, 6 * 3600_000)).toBe(false);
});

it("reports the same final snapshots with fewer heartbeats, and states lag/loss plainly", async () => {
  async function report(frequent: boolean, final = true): Promise<any[]> {
    await db.prepare("DELETE FROM pageviews").run();
    for (const [n, extra] of [[1, { s: "x", q: "post-1", c: "ent_aaaa1111" }], [2, { w: 1 }], [3, {}]] as const) {
      const id = `coalesce-report-${n}`;
      await send(db, { t: "pv", id, p: n === 3 ? "/" : "/journal/entry/", k: n === 3 ? "home" : "entry", ...extra });
      for (const seconds of frequent ? [15, 30, 45, 60] : final ? [30, 60] : [30]) {
        await send(db, { t: "hb", id, e: seconds * 1000, d: seconds === 60 ? 100 : 25 }, seconds * 1000);
      }
    }
    return Promise.all([{}, { src: "x" }, { post: "post-1" }, { content_id: "ent_aaaa1111" }, { include_test: true }].map(filter => analytics.stats(db, { now: new Date(+start + 3600_000), ...filter })));
  }
  const before = await report(true), after = await report(false);
  expect(after).toEqual(before);
  expect(after[0].totals.views).toBe(2);
  expect(after[4].totals.views).toBe(3);
  const lost = await report(false, false);
  expect(lost[0].totals.engaged_ms).toBeLessThan(after[0].totals.engaged_ms);
  expect(lost[0].notes).toContain("Time on page and scroll can lag up to a minute while someone is still reading.");
  expect(lost[0].notes).toContain("If the final message is lost, recorded time and scroll can be lower.");
});

it("uses the live site's timezone for views and never moves a heartbeat across midnight", async () => {
  await db.prepare("INSERT INTO live (item_id,kind,version,data,published_at) VALUES ('site','site',1,?,'2026-10-15')").bind(JSON.stringify({ timezone: "America/Los_Angeles" })).run();
  try {
    const now = new Date("2026-10-16T06:59:45Z");
    const put = (ev: Record<string, unknown>, ms: number) => analytics.collect(db, JSON.stringify(ev), {
      ip: "192.0.2.10", ua: "Mozilla/5.0 (reader)", notrack: false, host: "site.example", now: new Date(+now + ms),
    });
    await put({ t: "pv", id: "coalesce-tz-00001", p: "/" }, 0);
    await put({ t: "hb", id: "coalesce-tz-00001", e: 45000, d: 50 }, 45000);
    await put({ t: "pv", id: "coalesce-tz-00002", p: "/" }, 46000);
    expect(await row("coalesce-tz-00001")).toMatchObject({ day: "2026-10-15", engaged_ms: 45000 });
    expect(await row("coalesce-tz-00002")).toMatchObject({ day: "2026-10-16" });
    expect((await db.prepare("SELECT day FROM analytics_salts ORDER BY day").all()).results).toEqual([{ day: "2026-10-16" }]);
  } finally { await db.prepare("DELETE FROM live WHERE item_id = 'site'").run(); }
});
