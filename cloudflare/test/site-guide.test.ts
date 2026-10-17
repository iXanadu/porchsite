// SP-S3 paired with server/tests/app/test_site_guide.py.
import {env} from "cloudflare:workers";
import {beforeEach,expect,it} from "vitest";
import worker from "../src/index";
import * as keys from "../src/keys";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import {fixedGuide,GUIDE_KEYS,GUIDE_REVISION} from "../src/site-guide";
import type {Env} from "../src/env";
const e=env as unknown as Env,ctx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
const url="https://site.example";
async function raw(token:string,args:unknown={},headers:Record<string,string>={}){
 return worker.fetch(new Request(url+"/mcp",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json",...headers},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"site_state",arguments:args}})}),e,ctx);
}
async function call(token:string,args:unknown={}){const r=await raw(token,args);expect(r.status).toBe(200);const body=await r.text(),rpc=JSON.parse(body);const text=rpc.result.content[0].text;let value;try{value=JSON.parse(text);}catch{value=text;}return {value,text,error:!!rpc.result.isError,result:rpc.result,bodyBytes:new TextEncoder().encode(body).length};}
beforeEach(async()=>{for(const table of ["site_stream_settings","site_fields","private_approvals","site_embed_sources","items","live","revisions","approvals","publishes","assistant_keys"])await e.DB.prepare(`DELETE FROM ${table}`).run();await e.DB.prepare("UPDATE auth_state SET private_floor='',owner_epoch=0 WHERE id=1").run();});
it("site_state_guide_default_compat: omitted argument keeps exact default/full/ids shape",async()=>{
 const {token}=await keys.create(e.DB,"Fixture");
 const sizes:Record<string,unknown>={};
 for(const args of [{},{full:true},{ids:[]}]){
  const before=await call(token,args),first=await call(token,{...args,guide:{}});
  expect(before.error||first.error).toBe(false);expect(before.value.guide).toBeUndefined();
  const {guide,...without}=first.value;expect(JSON.stringify(without)).toBe(before.text);expect(guide).toEqual({revision:GUIDE_REVISION,included:true});
  if('ids' in args){const compact=await call(token,{...args,guide:{known_revision:GUIDE_REVISION}});for(const [name,r] of [["default",before],["first",first],["compact",compact]] as const)sizes[name]={contentBytes:new TextEncoder().encode(r.text).length,rpcBytes:r.bodyBytes};}

 }
 const output=(env as unknown as {GUIDE_MEASUREMENT_OUTPUT:string}).GUIDE_MEASUREMENT_OUTPUT;
 if(output)await expect(JSON.stringify(sizes,null,2)+"\n").toMatchFileSnapshot(output);
});
it("site_state_guide_conditional: matching, stale, unfamiliar and malformed declarations",async()=>{
 const {token}=await keys.create(e.DB,"Fixture");const first=await call(token,{guide:{}});
 for(const known_revision of [GUIDE_REVISION,"older-guide","ssg2:future"]){
  const r=await call(token,{guide:{known_revision}});expect(r.error).toBe(false);
  expect(r.value.guide).toEqual({revision:GUIDE_REVISION,included:known_revision!==GUIDE_REVISION});
  for(const key of GUIDE_KEYS)expect(Object.hasOwn(r.value,key)).toBe(known_revision!==GUIDE_REVISION);
  expect(r.value.items).toEqual(first.value.items);expect(r.value.update).toEqual(first.value.update);
 }
 for(const guide of [null,true,[],{unknown:1},{known_revision:null},{known_revision:1},{known_revision:""},{known_revision:"x".repeat(129)},{known_revision:"token\n"},{known_revision:"https://example.com"},{known_revision:"é"}]){
  const r=await call(token,{guide});expect(r.error,JSON.stringify(guide)).toBe(true);expect(typeof r.value).toBe("string");expect(r.result.structuredContent).toBeUndefined();expect(r.text).not.toContain(GUIDE_REVISION);
 }
});
it("site_state_guide_fresh_state: matching guide still reads versions, approvals, removal and unknown ids",async()=>{
 const {token}=await keys.create(e.DB,"Fixture"),who="assistant:Fixture";
 const item=await content.createItem(e.DB,who,"note",{text:"Before",date:"2026-10-17"},undefined);
 const args={ids:[item.id],guide:{known_revision:GUIDE_REVISION}};
 let r=await call(token,args);expect(r.value.items[0].version).toBe(1);
 await content.updateItem(e.DB,who,item.id,1,{text:"After"});
 const a=await approvals.request(e.DB,who,[item.id],"");r=await call(token,args);expect(r.value.items[0].data.text).toBe("After");expect(r.value.items[0].pending_approval).toBe(a.id);
 await approvals.decide(e.DB,a.id,{[item.id]:{decision:"approve"}},"");
 r=await call(token,args);expect(r.value.items[0].state).toBe("live");expect(r.value.items[0].version).toBe(2);
 await content.removeItem(e.DB,who,item.id,2);r=await call(token,args);expect(r.value.items[0].state).toBe("removal staged");
 expect((await call(token,{ids:[],guide:{known_revision:GUIDE_REVISION}})).value.items).toEqual([]);
 const unknown=await call(token,{ids:["missing"],guide:{known_revision:GUIDE_REVISION}});expect(unknown.error).toBe(true);expect(unknown.value.error).toBe("no_such_item");expect(unknown.value.guide).toBeUndefined();expect(unknown.result.structuredContent).toBeUndefined();
});
it("site_state_guide_access: private tool authorization precedes guide arguments and tokens grant no access",async()=>{
 const {token,id}=await keys.create(e.DB,"Fixture");
 const site=await content.createItem(e.DB,"assistant:Fixture","site",{title:"Private",private:true},undefined),a=await approvals.request(e.DB,"assistant:Fixture",[site.id],"");await approvals.decide(e.DB,a.id,{[site.id]:{decision:"approve"}},"");
 expect((await call(token,{guide:{}})).value.guide.included).toBe(true);
 for(const invalid of ["",GUIDE_REVISION,"psk_missing"]){const r=await raw(invalid,{guide:{unknown:1}});expect(r.status).toBe(401);expect(await r.text()).not.toContain(GUIDE_REVISION);}
 await e.DB.prepare("UPDATE assistant_keys SET revoked_at='2026-10-17' WHERE id=?").bind(id).run();expect((await raw(token,{guide:{known_revision:GUIDE_REVISION}})).status).toBe(401);
 for(const path of ["/","/site-state-guide.json","/.well-known/site-state-guide"]){const r=await worker.fetch(new Request(url+path),e,ctx);expect(r.status).toBe(404);expect(await r.text()).not.toContain(GUIDE_REVISION);}
});
function sorted(v:any):any {if(Array.isArray(v))return v.map(sorted);return v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;}
async function revision(guide:unknown){const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(sorted({format:1,guide})))));return "ssg1-sha256-"+[...digest].map(n=>n.toString(16).padStart(2,"0")).join("");}
it("site_state_guide_revision_parity: actual guide equals packaged revision and every block invalidates it",async()=>{
 expect(await revision(fixedGuide())).toBe(GUIDE_REVISION);
 for(const key of GUIDE_KEYS){const guide=structuredClone(fixedGuide()) as any;guide[key].revision_test="changed";expect(await revision(guide)).not.toBe(GUIDE_REVISION);}
});
it("site_state_guide_rollback: unfamiliar revisions refresh and new transport has no seen-guide state",async()=>{
 const {token}=await keys.create(e.DB,"Fixture");
 const first=await call(token,{ids:[],guide:{}}),second=await call(token,{ids:[],guide:{known_revision:first.value.guide.revision}});
 expect(second.value.guide.included).toBe(false);
 expect((await call(token,{ids:[],guide:{}})).value.guide.included).toBe(true);
 expect((await call(token,{ids:[],guide:{known_revision:"rollback-older-revision"}})).value.guide.included).toBe(true);
 expect((await call(token)).value.guide).toBeUndefined();
});
