import {env} from 'cloudflare:workers';
import {beforeEach,expect,it} from 'vitest';
import worker from '../src/index';
import * as keys from '../src/keys';
import * as read from '../src/read-keys';
import type {Env} from '../src/env';
import facts from '../../spec/fixtures/capability-facts.json';
import contract from '../../server/tests/app/cloudflare_tools.json';
const e=env as unknown as Env,db=e.DB,origin='https://site.example';
const ctx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
beforeEach(async()=>{
 const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name} of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();
});
async function rpc(token:string,method:string,params:Record<string,unknown>={},fallback=false){
 const r=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,...(fallback?{_meta:{fixture:true}}:{})}})}),e,ctx);
 expect(r.status).toBe(200);const body=await r.text();return JSON.parse(body.startsWith('{')?body:body.split('\n').find(x=>x.startsWith('data:'))!.slice(5));
}
function ordered(x:any):any{return Array.isArray(x)?x.map(ordered):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])):x;}
async function hash(x:any){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(ordered(x))));return [...new Uint8Array(b)].map(n=>n.toString(16).padStart(2,'0')).join('');}
it.each([false,true])('ai5 exact bounded prefix is the sole writer catalog delta, SDK=%s',async fallback=>{
 const {token}=await keys.create(db,'Fixture');const init=(await rpc(token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}},fallback)).result;
 expect(init.instructions).toBe(facts.previous_instructions);
 const tools=(await rpc(token,'tools/list',{},fallback)).result.tools;
 const prefix=facts.prefix+'\n\n';expect(new TextEncoder().encode(prefix).length).toBe(facts.prefix_bytes);expect(facts.prefix_bytes).toBeLessThanOrEqual(facts.max_prefix_bytes);
 const theme=tools.find((t:any)=>t.name==='theme_list');expect(theme.description).toBe(prefix+facts.previous_description);
 expect(tools.filter((t:any)=>t.description.includes(facts.prefix))).toHaveLength(1);
 theme.description=facts.previous_description;expect(await hash({instructions:init.instructions,tools})).toBe(facts.previous_catalog_sha256);
 expect(await db.prepare('SELECT count(*) FROM items').first('count(*)')).toBe(0);
});
it.each([false,true])('ai5 published reader catalog/instructions unchanged and theme_list refused, SDK=%s',async fallback=>{
 const {token}=await read.create(db,'Fixture');const init=(await rpc(token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}},fallback)).result;
 expect(init.instructions).toBe(read.INSTRUCTIONS);expect(init.instructions).not.toContain(facts.prefix);
 const tools=(await rpc(token,'tools/list',{},fallback)).result.tools;expect(tools).toEqual(contract.tools.filter(t=>facts.restricted_names.includes(t.name)));
 expect(tools.map((t:any)=>t.name).sort()).toEqual([...facts.restricted_names].sort());
 const denied=await rpc(token,'tools/call',{name:'theme_list',arguments:{}},fallback);expect(denied.error||denied.result?.isError).toBeTruthy();
 expect(await db.prepare('SELECT count(*) FROM items').first('count(*)')).toBe(0);
});
