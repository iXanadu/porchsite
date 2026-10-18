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
  await db.batch([db.prepare("DELETE FROM pageviews"), db.prepare("DELETE FROM analytics_visitor_counts"), db.prepare("DELETE FROM analytics_salts"), db.prepare("DELETE FROM analytics_daily"), db.prepare("UPDATE analytics_maintenance SET completed_day = '' WHERE id = 1")]);
});
it("admits exactly the final slot under contention, including test views, and retains admitted heartbeats", async () => {
  await seed(199);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => send(`final-slot-${i}`, { w: i % 2 })));
  expect(results.filter(Boolean)).toHaveLength(1); expect(await count()).toBe(200);
  expect(await db.prepare("SELECT views FROM analytics_visitor_counts").first("views")).toBe(200);
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
  await db.prepare("INSERT OR IGNORE INTO analytics_visitor_counts(day,visitor,views) VALUES('2026-01-01','old',1)").run();
  await db.prepare("INSERT INTO pageviews (id,day,visitor,path,kind,ref_bucket,engaged_ms,created_at,updated_at) VALUES ('expired-view','2026-01-01','old','/','home','direct',1000,'2026-01-01','2026-01-01')").run();
}
it("cleans once despite concurrent/stale readers, retains exact counts, and never lowers the watermark", async () => {
  await expired();
  const changes: number[] = [];
  const markers = new WeakSet<D1PreparedStatement>();
  const observed = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.startsWith("UPDATE analytics_maintenance")) return statement;
      return new Proxy(statement, { get(s, k) {
        if (k === "bind") return (...args: unknown[]) => { const bound = s.bind(...args); markers.add(bound); return bound; };
        const value = Reflect.get(s, k); return typeof value === "function" ? value.bind(s) : value;
      } });
    };
    if (key === "batch") return async (ss: D1PreparedStatement[]) => { const rs = await target.batch(ss); const index = ss.findIndex(s => markers.has(s)); if (index >= 0) changes.push(rs[index].meta.changes); return rs; };
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
  for (let i = 0; i < 5; i++) {
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

it("reconciles legacy writes, then denies saturated requests without scanning pageviews", async () => {
  expect(await send("counter-first-view")).toBe(true);
  const visitor = await visitorHash(db, day, "192.0.2.10", ua);
  await db.batch(Array.from({ length: 199 }, (_, i) => db.prepare("INSERT INTO pageviews (id,day,visitor,path,kind,ref_bucket,created_at,updated_at) SELECT ?,?,?, '/', 'home','direct',?,? WHERE NOT EXISTS (SELECT 1 FROM pageviews WHERE day=? AND visitor=? LIMIT 1 OFFSET 199)").bind(`legacy-view-${i}`,day,visitor,at.toISOString(),at.toISOString(),day,visitor)));
  expect(await db.prepare("SELECT views FROM analytics_visitor_counts WHERE day=? AND visitor=?").bind(day,visitor).first("views")).toBe(1);
  expect(await send("reconciled-denial")).toBe(false);expect(await count()).toBe(200);
  expect(await db.prepare("SELECT views FROM analytics_visitor_counts WHERE day=? AND visitor=?").bind(day,visitor).first("views")).toBe(200);
  let counterReads=0, sourceTouches=0;
  const guarded = new Proxy(db, { get(target,key) {
    if(key==="prepare")return (sql:string)=>{if(/FROM pageviews|INTO pageviews|UPDATE analytics_visitor_counts/.test(sql)){sourceTouches++;throw Error("saturated path touched source/write");}if(sql.startsWith("SELECT c.views"))counterReads++;return target.prepare(sql);};
    const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }});
  expect(await send("cheap-denial",{},guarded)).toBe(false);expect(counterReads).toBe(1);expect(sourceTouches).toBe(0);expect(await count()).toBe(200);
});
it("duplicates do not allocate another visitor counter or consume a slot", async()=>{
  expect(await send("duplicate-counter-view")).toBe(true);
  expect(await collect(db,JSON.stringify({t:"pv",id:"duplicate-counter-view",p:"/"}),{ip:"192.0.2.11",ua,notrack:false,host:"site.example",now:at})).toBe(false);
  expect((await db.prepare("SELECT views FROM analytics_visitor_counts").all()).results).toEqual([{views:1}]);
  expect(await count()).toBe(1);
});
it("rolls back every admission statement without consuming a counter slot",async()=>{
  await seed(1);await db.prepare("UPDATE analytics_maintenance SET completed_day=? WHERE id=1").bind(day).run();
  for(let index=0;index<2;index++){
    const fault=new Proxy(db,{get(target,key){
      if(key==="batch")return(ss:D1PreparedStatement[])=>target.batch(ss.map((s,i)=>i===index?target.prepare("INSERT INTO missing_counter_fault VALUES(1)"):s));
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});
    expect(await send(`counter-rollback-${index}`,{},fault)).toBe(false);
    expect(await count()).toBe(1);expect((await db.prepare("SELECT * FROM analytics_visitor_counts").all()).results).toEqual([]);
  }
});
it("a retired counter left by old maintenance is not a saturation certificate",async()=>{
  await seed(200);expect(await send("set-saturation-counter")).toBe(false);
  await db.prepare("DELETE FROM pageviews").run();
  await db.prepare("UPDATE analytics_maintenance SET completed_day='2027-03-01' WHERE id=1").run();
  expect(await send("retired-fallback-view")).toBe(true);expect(await count()).toBe(1);
  expect(await db.prepare("SELECT views FROM analytics_visitor_counts").first("views")).toBe(200);
});
it("missing counter schema retains the original complete cap and cleanup",async()=>{
  await seed(199);await db.prepare("ALTER TABLE analytics_visitor_counts RENAME TO saved_visitor_counts").run();
  try {expect(await send("old-schema-final-slot")).toBe(true);expect(await send("old-schema-denied")).toBe(false);expect(await count()).toBe(200);}
  finally {await db.prepare("ALTER TABLE saved_visitor_counts RENAME TO analytics_visitor_counts").run();}
});

it("shares the final slot with the released legacy admission statement",async()=>{
  await seed(199);const visitor=await visitorHash(db,day,"192.0.2.10",ua);
  const legacy=db.prepare("INSERT OR IGNORE INTO pageviews (id,day,visitor,path,kind,ref_bucket,created_at,updated_at) SELECT 'legacy-final-slot',?,?,'/','home','direct',?,? WHERE NOT EXISTS (SELECT 1 FROM pageviews WHERE day=? AND visitor=? LIMIT 1 OFFSET 199)").bind(day,visitor,at.toISOString(),at.toISOString(),day,visitor).run().then(r=>r.meta.changes===1);
  const results=await Promise.all([legacy,...Array.from({length:7},(_,i)=>send(`mixed-final-${i}`))]);
  expect(results.filter(Boolean)).toHaveLength(1);expect(await count()).toBe(200);
  expect(await send("mixed-final-denial")).toBe(false);
  expect(await db.prepare("SELECT views FROM analytics_visitor_counts").first("views")).toBe(200);
});

it("uses the native WITHOUT ROWID counter for new and existing accepted keys",async()=>{
  const ddl=await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='analytics_visitor_counts'").first<string>("sql");
  expect(ddl).toMatch(/WITHOUT ROWID/i);
  expect(await send("one-write-new-key")).toBe(true);
  expect(await db.prepare("SELECT views FROM analytics_visitor_counts").first("views")).toBe(1);
  expect(await send("one-write-existing-key")).toBe(true);
  expect(await count()).toBe(2);
  expect(await db.prepare("SELECT views FROM analytics_visitor_counts").first("views")).toBe(2);
  expect(await send("one-write-existing-key")).toBe(false);
  expect(await db.prepare("SELECT views FROM analytics_visitor_counts").first("views")).toBe(2);
});
