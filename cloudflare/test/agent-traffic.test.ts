// UC9 paired with server/tests/app/test_agent_traffic.py.
import {env} from "cloudflare:workers";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import cases from "../../spec/agent-traffic-cases.json";
import * as traffic from "../src/agent-traffic";
import * as analytics from "../src/analytics";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type {Env} from "../src/env";
import {handle} from "../src/routes";
import {BLANK} from "../src/privacy";
const e=env as unknown as Env, db=e.DB, who="assistant:test", origin="https://site.example";
const t1=new Date("2026-10-18T06:59:00Z"),t2=new Date("2026-10-18T07:01:00Z");
const at=(path:string,method="GET",headers:Record<string,string>={})=>handle(new Request(origin+path,{method,headers}),e);
async function publish(ids:string[]){const a=await approvals.request(db,who,ids,"");await approvals.decide(db,a.id,Object.fromEntries(ids.map(id=>[id,{decision:"approve" as const} ])),"");}
async function fixture(){const s=await content.createItem(db,who,"site",{title:"Counter fixture",timezone:"America/Los_Angeles",archive:{enabled:true}},undefined);const entry=await content.createItem(db,who,"entry",{title:"Counted entry",date:"2026-10-17"},undefined);await publish([s.id,entry.id]);return s;}
async function ownerCookie(){const token="count-owner-fixture";const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token)));const hash=btoa(String.fromCharCode(...digest)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");await db.prepare("INSERT INTO owner (id,name,user_handle,created_at) VALUES (1,'Owner','AA','2026-10-17')").run();await db.prepare("INSERT INTO sessions (token_hash,created_at,expires_at) VALUES (?,'2026-10-17','2099-01-01')").bind(hash).run();return `__Host-sk_owner=${token}`;}
beforeEach(async()=>{const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();for(const {name} of tables.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith("sqlite_")&&!name.startsWith("d1_"))await db.prepare(`DELETE FROM ${name}`).run();await db.prepare("INSERT INTO auth_state (id) VALUES (1)").run();});
afterEach(()=>vi.restoreAllMocks());

it("af_agent_kind_daily_counts: classes, HEAD/304, one llms request, concurrent increments and local date rollover",async()=>{
 await fixture();const original=traffic.observe;vi.spyOn(traffic,"observe").mockImplementation((d,q,r)=>original(d,q,r,t1));
 for(const ua of ["OAI-SearchBot","Claude-SearchBot","Googlebot","GPTBot","ClaudeBot","ChatGPT-User","Claude-User"]){expect((await at("/","GET",{"User-Agent":ua})).status).toBe(200);}
 const robots=await at("/robots.txt");expect(robots.status).toBe(200);expect((await at("/robots.txt","HEAD")).status).toBe(200);
 expect((await at("/robots.txt","GET",{"If-None-Match":robots.headers.get("ETag")!})).status).toBe(304);
 expect((await at("/llms.txt","GET",{"User-Agent":"OAI-SearchBot"})).status).toBe(200);
 expect((await at("/index.md","GET",{"User-Agent":"GPTBot"})).status).toBe(200);
 const response=new Response("",{headers:{"Content-Type":"text/html; charset=utf-8"}});
 await Promise.all(Array.from({length:24},()=>original(db,new Request(origin,{headers:{"User-Agent":"Claude-User"}}),response,t1)));
 await original(db,new Request(origin),response,t2);
 const r=await traffic.trafficReport(db,"2026-10-17","2026-10-18");
 expect(r.daily).toEqual([{day:"2026-10-17",kind:"search",requests:4},{day:"2026-10-17",kind:"training",requests:3},{day:"2026-10-17",kind:"user",requests:26},{day:"2026-10-17",kind:"other",requests:3},{day:"2026-10-18",kind:"other",requests:1}]);
 expect(r.totals.map(x=>x.requests)).toEqual([4,3,26,4]);
});
it("af_agent_kind_no_identifiers: schema and writes are aggregates; legacy analytics stay untouched",async()=>{
 await fixture();const schema=await db.prepare("PRAGMA table_info(agent_traffic_daily)").all<{name:string;pk:number}>();expect(schema.results.map(r=>r.name)).toEqual(["day","kind","requests"]);expect(schema.results.filter(r=>r.pk).map(r=>r.name)).toEqual(["day","kind"]);
 await at("/?request=not-stored","GET",{"User-Agent":"GPTBot/1.0 marker-not-stored","Referer":"https://example.com/secret","CF-Connecting-IP":"192.0.2.71","X-Request-Id":"not-stored-id"});
 const rows=await db.prepare("SELECT * FROM agent_traffic_daily").all();expect(rows.results).toHaveLength(1);expect(rows.results[0]).toMatchObject({kind:"training",requests:1});expect(JSON.stringify(rows.results)).not.toMatch(/GPTBot|192\.0|not-stored|secret|request_id/);
 for(const table of ["pageviews","analytics_daily","analytics_salts"])expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first("n")).toBe(0);
 await expect(db.prepare("INSERT INTO agent_traffic_daily VALUES ('2026-10-17','unknown',1)").run()).rejects.toThrow();await expect(db.prepare("INSERT INTO agent_traffic_daily VALUES ('2026-10-17','other',-1)").run()).rejects.toThrow();
});
it("af_agent_kind_owner_only: owner report, no public/private-denial leak or authenticated contribution",async()=>{
 const item=await fixture(),cookie=await ownerCookie();
 await at("/","GET",{"User-Agent":"GPTBot"});const before=await db.prepare("SELECT SUM(requests) n FROM agent_traffic_daily").first("n");
 for(const Cookie of [cookie,"__Host-sk_reader=invalid","__Host-sk_owner=expired"])expect((await at("/","GET",{Cookie})).status).toBe(200);
 await at("/","GET",{Authorization:"Bearer invalid"});
 const report=await at("/review/stats","GET",{Cookie:cookie});expect(report.status).toBe(200);expect(await report.text()).toContain("Requests by agent kind");expect(report.headers.get("Cache-Control")).toContain("no-store");
 const denied=await at("/review/stats");expect(denied.status).not.toBe(200);expect(await denied.text()).not.toContain("Requests by agent kind");
 expect(await db.prepare("SELECT SUM(requests) n FROM agent_traffic_daily").first("n")).toBe(before);
 for(const path of ["/","/index.md","/llms.txt","/sitemap.xml"]){expect(await(await at(path)).text()).not.toContain("Requests by agent kind");}
 await content.updateItem(db,who,item.id,item.version,{private:true});await publish([item.id]);
 const n=await db.prepare("SELECT SUM(requests) n FROM agent_traffic_daily").first("n");
 for(const path of ["/","/index.md","/llms.txt","/robots.txt","/journal/feed.xml","/sitemap.xml","/archive/"])for(const method of ["GET","HEAD"]){const r=await at(path,method);expect(r.status).toBe(path==="/robots.txt"?200:404);if(path==="/"&&method==="GET")expect(await r.text()).toBe(BLANK);}
 expect((await at("/review/stats","GET",{Cookie:cookie})).status).toBe(200);expect(await db.prepare("SELECT SUM(requests) n FROM agent_traffic_daily").first("n")).toBe(n);
});
it("af_agent_kind_parity_rollback: shared classification, aggregate report and site-wide filters",async()=>{
 await fixture();for(const c of cases.agents)expect(traffic.agentKind(c.ua),c.ua).toBe(c.kind);expect(traffic.agentKind("x".repeat(4097)+" GPTBot")).toBe("other");
 for(const row of cases.rows)await db.prepare("INSERT INTO agent_traffic_daily VALUES (?,?,?)").bind(row.day,row.kind,row.requests).run();
 const s=await analytics.stats(db,{days:2,now:t1,content_id:"not-an-item",src:"campaign"}) as any;expect(s.agent_traffic.daily).toEqual(traffic.formatTraffic(cases.rows as traffic.TrafficRow[],"2026-10-16","2026-10-17").daily);expect(s.agent_traffic.scope).toContain("Whole site");
});
it("excludes failures, misses, protocol/capability paths and other representations",async()=>{
 await fixture();for(const path of ["/missing/","/setup","/login","/static/a.js","/manifest.webmanifest","/journal/search.json","/media/00000000000000000000000000000000.jpg"])await at(path);
 await at("/","POST");await at("/","GET",{Accept:"text/markdown;q=0,text/html;q=0"});await at("/archive/?sort=invalid");
 expect(await db.prepare("SELECT count(*) n FROM agent_traffic_daily").first("n")).toBe(0);
});
it("counter failures preserve public response delivery",async()=>{
 await fixture();vi.spyOn(traffic,"observe").mockRejectedValue(new Error("counter unavailable"));const r=await at("/");expect(r.status).toBe(200);expect(await r.text()).toContain("Counter fixture");
});
it("public representations count each anonymous GET, HEAD and 304 once",async()=>{
 await fixture();
 const paths=["/","/index.md","/robots.txt","/journal/feed.xml","/sitemap.xml","/llms.txt","/archive/","/archive/index.md"];
 for(const path of paths){
  const headers={"User-Agent":"OAI-SearchBot"},r=await at(path,"GET",headers);
  expect(r.status,path).toBe(200);expect(r.headers.get("ETag"),path).toBeTruthy();
  expect((await at(path,"HEAD",headers)).status,path).toBe(200);
  expect((await at(path,"GET",{...headers,"If-None-Match":r.headers.get("ETag")!})).status,path).toBe(304);
 }
 expect(await db.prepare("SELECT SUM(requests) n FROM agent_traffic_daily WHERE kind='search'").first("n")).toBe(paths.length*3);
 expect(await db.prepare("SELECT count(*) n FROM agent_traffic_daily WHERE kind!='search'").first("n")).toBe(0);
});
