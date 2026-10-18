// A deliberately incomplete installed look must not hide a published entry
// from site_check. Port-matched: server/tests/app/test_stage_one_check.py.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as keys from "../src/keys";
import { THEMES } from "../src/themes.gen";

it("reports the published entry a rendered look drops, excluding drafts", async () => {
  const e = env as unknown as Env;
  const db = e.DB;
  const who = "assistant:test";
  const s = await content.createItem(db, who, "site", { title: "Test", theme: "dropped-entry", sections: ["entries"] }, undefined);
  const visible = await content.createItem(db, who, "entry", { title: "Visible", date: "2026-10-10", slug: "visible", status: "ready" }, undefined);
  const hidden = await content.createItem(db, who, "entry", { title: "Hidden", date: "2026-10-09", slug: "hidden", status: "ready" }, undefined);
  const draft = await content.createItem(db, who, "entry", { title: "Draft", date: "2026-10-08", status: "draft" }, undefined);
  // Direct fixture installation intentionally bypasses the look quality gate.
  const base = THEMES["product-page"];
  const look = { ...base, manifest: { ...base.manifest, name: "dropped-entry" }, pages: { ...base.pages, home: '<html><body><a href="/journal/visible/">{{site.title}}</a></body></html>', entry: '<html><body><a href="/">{{site.title}}</a></body></html>' } };
  await db.prepare("INSERT INTO themes (name, version, package, sha256, installed_at, installed_by, source) VALUES (?, ?, ?, ?, ?, ?, 'private')").bind("dropped-entry", "1.0.0", JSON.stringify(look), "fixture", "2026-10-15", who).run();
  const ids = [s.id, visible.id, hidden.id];
  const request = await approvals.request(db, who, ids, "");
  await approvals.decide(db, request.id, Object.fromEntries(ids.map(id => [id, { decision: "approve" as const }])), "");
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const home = await (await worker.fetch(new Request("https://site.example/"), e, ctx)).text();
  expect(home).toContain('href="/journal/visible/"');
  expect(home).not.toContain("/journal/hidden/");
  const visiblePage = await (await worker.fetch(new Request("https://site.example/journal/visible/"), e, ctx)).text();
  expect(visiblePage).toContain('href="/"');
  expect(visiblePage).not.toContain('href="/journal/"');
  const { token } = await keys.create(db, "Test");
  const quickResponse = await worker.fetch(new Request("https://site.example/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "site_check", arguments: {} } }) }), e, ctx);
  const quick = await quickResponse.json() as any;
  expect(JSON.parse(quick.result.content[0].text)).toEqual({ok: true, broken: [], empty_sections: []});
  const response = await worker.fetch(new Request("https://site.example/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "site_check", arguments: { deep: true } } }) }), e, ctx);
  expect(response.status).toBe(200);
  const rpc = await response.json() as any;
  expect(rpc.result.isError).not.toBe(true);
  const result = JSON.parse(rpc.result.content[0].text);
  expect(result.ok).toBe(false);
  expect(result.unreachable.map((x: any) => x.id)).toEqual([hidden.id]);
  expect(result.unreachable[0].why).toEqual(expect.any(String));
  expect(result.unreachable[0].why.length).toBeGreaterThan(0);
});

it('site_check_target_graph: proposed draft/removal/replacement never borrows published or prepared targets',async()=>{
 const e=env as unknown as Env,db=e.DB,who='assistant:test';
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name} of tables.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();
 const contentSite=await content.createItem(db,who,'site',{title:'Graph',theme:'target-graph',sections:['entries'],archive:{enabled:true,title:'All pages'}},undefined);
 const a=await content.createItem(db,who,'entry',{title:'A',slug:'a',date:'2026-10-10',body:'Old approved A',status:'ready'},undefined);
 const c=await content.createItem(db,who,'entry',{title:'C',slug:'c',date:'2026-10-10',body:'Approved C',status:'ready'},undefined);
 const base=THEMES['product-page'],look={...base,manifest:{...base.manifest,name:'target-graph'},pages:{...base.pages,home:'<a href="/journal/b/">Proposed B</a>',entry:'Entry'}};
 await db.prepare("INSERT INTO themes(name,version,package,sha256,installed_at,installed_by,source) VALUES(?,?,?,?,?,?,'private')").bind('target-graph','1.0.0',JSON.stringify(look),'fixture','2026-10-18',who).run();
 await approvals.publishNow(db,[contentSite,a,c].map(x=>({id:x.id,version:x.version})),'','https://site.example');
 await content.updateItem(db,who,a.id,a.version,{body:'Proposed draft A',status:'draft'});
 await content.removeItem(db,who,c.id,c.version);
 const b=await content.createItem(db,who,'entry',{title:'B',slug:'b',date:'2026-10-10',body:'Proposed ready B',status:'ready'},undefined);
 // A deliberately irrelevant public artifact must not supply graph evidence.
 await db.prepare("INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size) VALUES('graph-fixture','fixture','<a href=\"/journal/a/\">A</a><a href=\"/journal/c/\">C</a>','{}',9999999999999,1)").run();
 const writer=await keys.create(db,'Writer'),read=await import('../src/read-keys'),reader=await read.create(db,'Reader');
 const ctx={waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext;
 const call=async(token:string)=>{
  const r=await worker.fetch(new Request('https://site.example/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'site_check',arguments:{deep:true}}})}),{...e,PUBLIC_ARTIFACTS:'1'},ctx);
  const rpc=await r.json() as any;expect(rpc.result.isError).not.toBe(true);return JSON.parse(rpc.result.content[0].text);
 };
 const proposed=await call(writer.token);expect(proposed).toEqual({ok:true,broken:[],empty_sections:[],unreachable:[]});
 const approved=await call(reader.token);expect(approved.ok).toBe(false);expect(approved.unreachable.map((x:any)=>x.id).sort()).toEqual([a.id,c.id].sort());
 expect(approved.unreachable.some((x:any)=>x.id===b.id)).toBe(false);
});
