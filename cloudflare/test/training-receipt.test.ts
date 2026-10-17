// AF-C1 acceptance: paired with server/tests/app/test_training_receipt.py.
import {env} from 'cloudflare:workers';
import {beforeEach,expect,it} from 'vitest';
import type {Env} from '../src/env';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as history from '../src/history';
import * as importer from '../src/importer';
import * as fields from '../src/site-fields';
import {trainingDisabled} from '../src/public-http';
import {handle} from '../src/routes';
async function hash(value:string){return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
import * as keys from '../src/keys';
import worker from '../src/index';
const e=env as unknown as Env,db=e.DB,actor='assistant:test',origin='https://site.example';
beforeEach(async()=>{
 const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name} of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state (id) VALUES (1)').run();
});
async function site(){return content.createItem(db,actor,'site',{title:'Receipt fixture',theme:'personal-homepage',ai_training_disabled:true},undefined);}
async function publish(item:content.Item){const a=await approvals.request(db,actor,[item.id],'');await approvals.decide(db,a.id,{[item.id]:{decision:'approve'}},'',origin);return a;}
async function n(){return Number(await db.prepare('SELECT count(*) FROM training_approvals').first('count(*)'));}
async function oldApprove(item:content.Item){await db.batch([
 db.prepare("INSERT OR REPLACE INTO live (item_id,kind,slug,data,version,published_at) SELECT id,kind,slug,data,version,'2026-10-17' FROM items WHERE id='site'"),
 db.prepare('UPDATE site_fields SET approved=1 WHERE version=?').bind(item.version)]);}
async function get(path='/',headers:Record<string,string>={}){return handle(new Request(origin+path,{headers}),e);}
it('af_training_receipt_exact_version: all four facts are required; draft reads retain the proposal',async()=>{
 const one=await site();expect(await fields.trainingData(db,one.version,false)).toBe(true);await oldApprove(one);
 expect(await fields.trainingData(db,one.version,true)).toBe(false);expect(await trainingDisabled(db)).toBe(false);expect(await n()).toBe(0);
 await db.prepare('INSERT INTO training_approvals(version) VALUES (?)').bind(one.version+99).run();expect(await trainingDisabled(db)).toBe(false);
 await db.batch([fields.trainingApproval(db,one.version)]);expect(await trainingDisabled(db)).toBe(true);
 await db.prepare("UPDATE site_fields SET approved=0 WHERE key='ai_training_disabled'").run();expect(await trainingDisabled(db)).toBe(false);
 await db.prepare("UPDATE site_fields SET approved=1,value='false' WHERE key='ai_training_disabled'").run();expect(await trainingDisabled(db)).toBe(false);
 await db.prepare("DELETE FROM site_fields WHERE key='ai_training_disabled'").run();expect(await trainingDisabled(db)).toBe(false);
});
it('af_training_receipt_owner_publish: both owner paths receipt only successfully published site versions',async()=>{
 const one=await site();const a=await publish(one);expect(await trainingDisabled(db)).toBe(true);expect(await n()).toBe(1);
 const two=await content.updateItem(db,actor,'site',one.version,{title:'Changed'});
 const wait=await approvals.request(db,actor,['site'],'');await approvals.decide(db,wait.id,{site:{decision:'later'}},'',origin);expect(await n()).toBe(1);
 await approvals.decide(db,wait.id,{site:{decision:'deny'}},'',origin);expect(await n()).toBe(1);
 await approvals.publishNow(db,[{id:'site',version:two.version}],'',origin);expect(await n()).toBe(2);
 await approvals.decide(db,a.id,{site:{decision:'approve'}},'',origin);expect(await n()).toBe(2);
 const three=await content.updateItem(db,actor,'site',two.version,{title:'Third'});const stale=await approvals.request(db,actor,['site'],'');
 await content.updateItem(db,actor,'site',three.version,{title:'Fourth'});await approvals.decide(db,stale.id,{site:{decision:'approve'}},'',origin);expect(await n()).toBe(2);
 const card=await content.createItem(db,actor,'card',{name:'Card',description:'Only a card'},undefined);await publish(card);expect(await n()).toBe(2);
});
it('af_training_receipt_owner_publish: a receipt failure rolls back live and field approval atomically',async()=>{
 const one=await site();await db.prepare("CREATE TRIGGER receipt_failure BEFORE INSERT ON training_approvals BEGIN SELECT RAISE(ABORT,'receipt failure'); END").run();
 try{await expect(publish(one)).rejects.toThrow();expect(await db.prepare("SELECT version FROM live WHERE item_id='site'").first()).toBeNull();expect(await db.prepare("SELECT approved FROM site_fields WHERE key='ai_training_disabled'").first('approved')).toBe(0);expect(await n()).toBe(0);}
 finally{await db.prepare('DROP TRIGGER receipt_failure').run();}
});
it('af_training_receipt_copy_restore: new versions never inherit receipts; removal and revert use owner publication',async()=>{
 const one=await site();await publish(one);const first=(await history.publishes(db))[0].id;
 const two=await content.updateItem(db,actor,'site',one.version,{ai_training_disabled:false});await publish(two);expect(await trainingDisabled(db)).toBe(false);expect(await n()).toBe(1);
 const restored=await content.rollback(db,actor,'site',one.version,two.version);expect(restored.data.ai_training_disabled).toBe(true);expect(await n()).toBe(1);await oldApprove(restored);expect(await trainingDisabled(db)).toBe(false);
 await approvals.publishNow(db,[{id:'site',version:restored.version}],'',origin);expect(await trainingDisabled(db)).toBe(true);expect(await n()).toBe(2);
 const off=await content.updateItem(db,actor,'site',restored.version,{ai_training_disabled:false});await publish(off);
 await history.revert(db,first,'',origin);expect(await trainingDisabled(db)).toBe(true);expect(await n()).toBe(3);
});
it('af_training_receipt_no_backfill: reads and requests never certify old approved fields; protected state explains effective choice',async()=>{
 const one=await site();await oldApprove(one);
 expect(await fields.trainingState(db)).toEqual({proposed_disabled:true,effective_disabled:false,needs_publication:true,note:fields.TRAINING_NOTE});
 const token='receipt-owner';await db.batch([db.prepare("INSERT INTO owner(id,name,user_handle,created_at) VALUES(1,'Owner','fixture','2026-10-17')"),db.prepare("INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,'2026-10-17','2099-01-01')").bind(await hash(token))]);
 const review=await get('/review',{Cookie:`__Host-sk_owner=${token}`});expect(review.status).toBe(200);expect(await review.text()).toContain(fields.TRAINING_NOTE);
 const {token:access}=await keys.create(db,'Fixture');const response=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'site_state',arguments:{ids:['site']}}})}),e,{waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext);
 const rpc:any=await response.json();expect(JSON.parse(rpc.result.content[0].text).training_choice).toEqual(await fields.trainingState(db));expect(await n()).toBe(0);
 const fresh=await content.updateItem(db,actor,'site',one.version,{title:'Fresh shown version'});await approvals.request(db,actor,['site'],'');expect(await n()).toBe(0);await approvals.publishNow(db,[{id:'site',version:fresh.version}],'',origin);expect((await fields.trainingState(db)).needs_publication).toBe(false);
});
it('af_training_receipt_http_parity: old approval cannot change robots or validators; a real receipt changes both',async()=>{
 const one=await site();await oldApprove(one);const before=await get();const tag=before.headers.get('ETag')!;expect(before.headers.get('Content-Signal')).toContain('ai-train=yes');expect(await (await get('/robots.txt')).text()).not.toContain('GPTBot');
 await db.prepare('UPDATE site_fields SET approved=1').run();expect((await get('/',{'If-None-Match':tag})).status).toBe(304);
 await approvals.publishNow(db,[{id:'site',version:one.version}],'',origin);const after=await get('/',{'If-None-Match':tag});expect(after.status).toBe(200);expect(after.headers.get('ETag')).not.toBe(tag);expect(after.headers.get('Content-Signal')).toContain('ai-train=no');expect(await (await get('/robots.txt')).text()).toContain('GPTBot');
 const auth=await get('/',{Authorization:'Bearer fixture'});expect(auth.headers.get('Cache-Control')).toContain('no-store');expect(auth.headers.has('ETag')).toBe(false);expect(await (await get()).text()).not.toContain('training_approvals');
});

it('af_training_receipt_copy_restore: importing a proposed true choice never imports a receipt',async()=>{
 await importer.importFile(db,JSON.stringify({porchsite_import:1,from:'Fixture',items:[{kind:'site',data:{title:'Imported',theme:'personal-homepage',ai_training_disabled:true}}],training_approvals:[1]}));
 expect(await n()).toBe(0);expect(await trainingDisabled(db)).toBe(false);expect((await content.getItem(db,'site')).data.ai_training_disabled).toBe(true);
});
