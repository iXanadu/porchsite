// Past their 90 days, a day's page views go and its counts stay (SPEC §8).
// Port-matched: server/tests/app/test_analytics_earlier.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as analytics from "../src/analytics";
import type { Env } from "../src/env";

const db = (env as unknown as Env).DB;
const old = (id: string, visitor: string, test = 0) =>
  db
    .prepare("INSERT INTO pageviews (id, day, visitor, path, kind, ref_bucket, test, engaged_ms, created_at, updated_at) VALUES (?, '2026-06-01', ?, '/', 'home', 'direct', ?, 1000, '2026-06-01T12:00:00Z', '2026-06-01T12:00:00Z')")
    .bind(id, visitor, test)
    .run();

describe("analytics past 90 days", () => {
  it("keeps a day's counts as its views are deleted, and reports them by month", async () => {
    await old("old-view-0001", "a");
    await old("old-view-0002", "a");
    await old("old-view-0003", "b");
    await old("old-view-0004", "c", 1);
    const now = new Date("2026-10-12T12:00:00Z");
    await analytics.collect(db, JSON.stringify({ t: "pv", id: "new-view-0001", p: "/", k: "home" }), { ip: "192.0.2.10", ua: "Mozilla/5.0 (test reader)", notrack: false, host: "site.example", now });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM pageviews WHERE day = '2026-06-01'").first("n")).toBe(0);
    expect(await db.prepare("SELECT day, visits, views, engaged_ms FROM analytics_daily").all().then((r) => r.results)).toEqual([
      { day: "2026-06-01", visits: 2, views: 3, engaged_ms: 3000 },
    ]);
    const s = await analytics.stats(db, { now });
    expect(s.earlier).toEqual([{ month: "2026-06", visits: 2, views: 3, engaged_ms: 3000 }]);
    expect((await analytics.stats(db, { now, content_id: "ent_aaaa1111" })).earlier).toEqual([]);
  });
});
