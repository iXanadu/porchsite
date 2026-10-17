import * as ownerAuth from '../src/owner';
import {env} from 'cloudflare:workers';
import {beforeEach,it,expect,vi} from 'vitest';
import * as read from '../src/read-keys';
import * as keys from '../src/keys';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as published from '../src/published-read';
import worker from '../src/index';
import {handle} from '../src/routes';
import {createToolHandlers} from '../src/mcp';
import {withToolContext} from '../src/tool-context';
import type {Env} from '../src/env';
const e=env as unknown as Env,db=e.DB,origin='https://site.example';
const ctx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
beforeEach(async()=>{
 vi.restoreAllMocks();
 const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name} of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();
});
const go=(path:string,init?:RequestInit)=>worker.fetch(new Request(origin+path,init),e,ctx);
async function rpc(token:string,method:string,params:any={},fallback=false){
 const response=await go('/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:fallback?'application/json':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:fallback?{...params,_meta:{test:true}}:params})});
 const text=await response.text();return {response,data:JSON.parse(text.startsWith('{')?text:(text.split('\n').find(x=>x.startsWith('data:'))??'data:{}').slice(5))};
}
async function fixture(){
 const site=await content.createItem(db,'assistant:test','site',{title:'Published title'},undefined);await approvals.publishNow(db,[{id:'site',version:site.version}],'',origin);
 await content.updateItem(db,'assistant:test','site',site.version,{title:'DRAFT SENTINEL'});
}
it('ag_key_prefix_new_table and live expiry/epoch lookup',async()=>{
 const made=await read.create(db,'Reader');expect(made.token).toMatch(/^prk_[A-Za-z0-9_-]{32}$/);expect(await keys.lookup(db,made.token)).toBeNull();
 const props=await read.lookup(db,made.token);expect(props?.scope).toBe('published_read');expect(JSON.stringify(await read.list(db))).not.toContain(made.token);expect((await read.events(db))[0].kind).toBe('created');
 await db.prepare('UPDATE auth_state SET owner_epoch=owner_epoch+1 WHERE id=1').run();expect(await read.lookup(db,made.token)).toBeNull();expect(await read.valid(db,props!)).toBe(false);
});
it('ag_revoke_immediate and audit are atomic/idempotent',async()=>{
 const made=await read.create(db,'Reader'),props=await read.lookup(db,made.token);await read.revoke(db,made.id);await read.revoke(db,made.id);
 expect(await read.lookup(db,made.token)).toBeNull();expect(await read.valid(db,props!)).toBe(false);expect((await read.events(db)).filter(x=>x.kind==='revoked')).toHaveLength(1);expect(JSON.stringify(await read.events(db))).not.toContain(made.token);
 const other=await read.create(db,'Other');await db.prepare("CREATE TRIGGER fail_read_audit BEFORE INSERT ON agent_read_key_events WHEN NEW.kind='revoked' BEGIN SELECT RAISE(ABORT,'audit failure'); END").run();
 try{await expect(read.revoke(db,other.id)).rejects.toThrow();expect(await read.lookup(db,other.token)).not.toBeNull();}finally{await db.prepare('DROP TRIGGER fail_read_audit').run();}
});
it.each([false,true])('ag_tools_enforced fast/fallback=%s, no draft projection',async(fallback)=>{
 await fixture();const made=await read.create(db,'Reader');
 const init=await rpc(made.token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}},fallback);expect(init.data.result.instructions).toBe(read.INSTRUCTIONS);
 const listed=await rpc(made.token,'tools/list',{},fallback);const names=listed.data.result.tools.map((t:any)=>t.name);expect(names).toContain('site_state');expect(names.every((n:string)=>read.ALLOWED.has(n))).toBe(true);
 const before=await db.prepare('SELECT count(*) AS n FROM items').first('n');
 for(const [name,args] of [['item_create',{kind:'note',data:{text:'WRONG',date:'2026-10-17'}}],['approval_request',{ids:['site'],note:''}],['image_add',{data:'not-image'}],['site_stats',{}],['item_history',{id:'site'}]] as [string,any][]){const out=await rpc(made.token,'tools/call',{name,arguments:args},fallback);expect(out.data.error||out.data.result?.isError).toBeTruthy();}
 expect(await db.prepare('SELECT count(*) AS n FROM items').first('n')).toBe(before);
 const state=await rpc(made.token,'tools/call',{name:'site_state',arguments:{guide:{}}},fallback);expect(JSON.stringify(state.data)).not.toContain('DRAFT SENTINEL');expect(JSON.parse(state.data.result.content[0].text).site.title).toBe('Published title');expect(state.response.headers.get('Cache-Control')).toBe('private, no-store, no-transform');
 const full=await rpc(made.token,'tools/call',{name:'site_state',arguments:{full:true}},fallback);expect(full.data.result.isError).toBe(true);
 await read.revoke(db,made.id);expect((await rpc(made.token,'tools/list',{},fallback)).response.status).toBe(401);
});
it('ag_revocation_delivery_race rechecks a cached transport principal',async()=>{
 await fixture();const made=await read.create(db,'Reader'),props={...await read.lookup(db,made.token),origin};
 const original=published.state;vi.spyOn(published,'state').mockImplementation(async(...args)=>{const value=await original(...args);await read.revoke(db,made.id);return value;});
 const result=await withToolContext(props,()=>createToolHandlers().get('site_state')!({}));expect(result.isError).toBe(true);expect(JSON.stringify(result)).not.toContain('Published title');
});
it('ag_key_issue_once owner POST only; last use and revoke list',async()=>{
 const token='owner-read-test';const hash=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 await db.prepare("INSERT INTO owner(id,name,user_handle,created_at) VALUES(1,'Owner','AA','2026-10-17')").run();await db.prepare("INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,'2026-10-17','2099-01-01')").bind(hash).run();
 const cookie='__Host-sk_owner='+token,page=await(await go('/review/assistants',{headers:{Cookie:cookie}})).text(),csrf=/name="csrf" value="([^"]+)"/.exec(page)![1];
 const made=await go('/review/assistants',{method:'POST',headers:{Cookie:cookie},body:new URLSearchParams({csrf,key_name:'Reader',make_key:'1',read_only:'1'})}),text=await made.text(),key=/prk_[A-Za-z0-9_-]{32}/.exec(text)![0];expect(made.headers.get('Cache-Control')).toContain('no-store');
 const after=await(await go('/review/assistants',{headers:{Cookie:cookie}})).text();expect(after).not.toContain(key);expect(after).toContain('Read only — published pages');
 expect((await go('/mcp?key='+key,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(401);
});

it('ag_key_issue_atomic refuses secret content and rolls back failed issuance',async()=>{
 const made=await read.create(db,'Reader');
 await expect(content.createItem(db,'assistant:test','note',{text:made.token,date:'2026-10-17'},undefined)).rejects.toMatchObject({code:'content_guard'});
 await expect(read.create(db,made.token)).rejects.toMatchObject({code:'content_guard'});
 await db.prepare("CREATE TRIGGER fail_read_create BEFORE INSERT ON agent_read_key_events WHEN NEW.kind='created' BEGIN SELECT RAISE(ABORT,'audit failure'); END").run();
 try{await expect(read.create(db,'Failure')).rejects.toThrow();expect(await db.prepare("SELECT count(*) AS n FROM agent_read_keys WHERE name='Failure'").first('n')).toBe(0);}finally{await db.prepare('DROP TRIGGER fail_read_create').run();}
 await db.prepare("UPDATE agent_read_keys SET expires_at='2000-01-01' WHERE id=?").bind(made.id).run();expect(await read.lookup(db,made.token)).toBeNull();
});

it('ag_owner_issue_fenced: recovery between form validation and batch cannot mint a read key',async()=>{
 const token='owner-fenced-test';const hash=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 await db.prepare("INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,'2026-10-17','2099-01-01')").bind(hash).run();
 const request=new Request(origin+'/review/assistants',{headers:{Cookie:'__Host-sk_owner='+token}});expect(await ownerAuth.signedIn(db,request)).toBe(true);
 const original=ownerAuth.ownerSessionGuard;vi.spyOn(ownerAuth,'ownerSessionGuard').mockImplementation(async(req)=>{const gate=await original(req);await db.prepare('UPDATE auth_state SET owner_epoch=owner_epoch+1 WHERE id=1').run();return gate;});
 await expect(read.create(db,'Fenced','owner',request)).rejects.toMatchObject({code:'not_verified'});
 expect(await db.prepare('SELECT count(*) AS n FROM agent_read_keys').first('n')).toBe(0);expect(await read.events(db)).toHaveLength(0);
 vi.restoreAllMocks();const next=await read.create(db,'New owner');await expect(read.revoke(db,next.id,'owner',request)).rejects.toMatchObject({code:'not_verified'});expect(await read.lookup(db,next.token)).not.toBeNull();
});
