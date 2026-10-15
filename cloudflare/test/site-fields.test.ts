import {env} from 'cloudflare:workers';
import {beforeEach,expect,it} from 'vitest';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as history from '../src/history';
import * as keys from '../src/keys';
import worker from '../src/index';
import {SiteData} from '../src/models';
import {THEMES} from '../src/themes.gen';
import {renderSample} from '../src/themecheck';
import sample from '../../themes/listing-page/sample.json';
import type {Env} from '../src/env';
const db=(env as unknown as Env).DB,actor='assistant:test',origin='https://site.example';
beforeEach(async()=>{await db.batch(['site_fields','site_embed_sources','items','revisions','live','approvals','publishes','idempotency'].map(t=>db.prepare(`DELETE FROM ${t}`)));});
async function publish(item:content.Item){const a=await approvals.request(db,actor,[item.id],'');await approvals.decide(db,a.id,{[item.id]:{decision:'approve'}},'',origin);}
it('versions broker values through approval, removal, rollback and whole-site revert without poisoning legacy JSON',async()=>{
 const one=await content.createItem(db,actor,'site',{broker:'Example Brokerage'},undefined);expect((await content.siteData(db,true)).broker).toBe('');await publish(one);
 const two=await content.updateItem(db,actor,'site',one.version,{broker:'Another Brokerage'});expect((await content.getItem(db,'site')).data.broker).toBe('Another Brokerage');expect((await content.siteData(db,true)).broker).toBe('Example Brokerage');await publish(two);const second=(await history.publishes(db))[0].id;
 const removed=await content.updateItem(db,actor,'site',two.version,{broker:''});await publish(removed);expect((await content.siteData(db,true)).broker).toBe('');
 const restored=await content.rollback(db,actor,'site',one.version,removed.version);expect(restored.data.broker).toBe('Example Brokerage');await publish(restored);expect((await content.siteData(db,true)).broker).toBe('Example Brokerage');
 await history.revert(db,second,'',origin);expect((await content.siteData(db,true)).broker).toBe('Another Brokerage');
 const rows=await db.prepare("SELECT data FROM items WHERE id='site' UNION ALL SELECT data FROM revisions WHERE item_id='site' UNION ALL SELECT data FROM live WHERE item_id='site'").all<{data:string}>();for(const r of rows.results){expect(JSON.parse(r.data)).not.toHaveProperty('broker');expect(SiteData.safeParse(JSON.parse(r.data)).success).toBe(true);}
});
it('never inherits or approves broker through an old runtime copy or stale write, and bounds the input',async()=>{
 const one=await content.createItem(db,actor,'site',{broker:'Approved Brokerage'},undefined);await publish(one);await content.updateItem(db,actor,'site',1,{broker:'Unseen Brokerage'});
 await db.prepare("UPDATE live SET data=(SELECT data FROM items WHERE id='site'),version=2 WHERE item_id='site'").run();expect((await content.siteData(db,true)).broker).toBe('');
 await expect(content.updateItem(db,actor,'site',1,{broker:'Wrong'})).rejects.toMatchObject({code:'version_conflict'});expect((await db.prepare('SELECT count(*) AS n FROM site_fields').first<any>()).n).toBe(2);
 expect(()=>content.validate('site',{broker:'x'.repeat(161)})).toThrow();expect(()=>content.validate('site',{unknown_extension:'x'})).toThrow();expect(content.validate('site',{broker:'x'.repeat(160)}).broker).toHaveLength(160);
});
it('shows escaped brokerage after contact and all visible cards after stats on both Listing pages',()=>{
 const input:any=structuredClone(sample);input.site.broker='<Broker & Co>';input.items.push({kind:'card',data:{name:'A public highlight',description:'Visible',link:'https://example.com/visit'}},{kind:'card',data:{name:'Mention highlight',description:'Name only',visibility:'mention',link:'https://private.example/secret',image:'https://private.example/secret.jpg'}},{kind:'card',data:{name:'Private highlight',description:'Hidden',visibility:'private'}} as any);
 const pages=renderSample(THEMES['listing-page'] as any,input);
 for(const key of ['index.html','listing/home/index.html']){const html=pages[key];expect(html).toContain('&lt;Broker &amp; Co&gt;');expect(html.indexOf('class="broker"')).toBeGreaterThan(html.indexOf('owner@example.com'));expect(html.indexOf('class="highlights"')).toBeGreaterThan(html.indexOf('class="stats"'));expect(html).toContain('A public highlight');expect(html).toContain('Mention highlight');expect(html).not.toContain('Private highlight');expect(html).not.toContain('private.example');expect(html).toContain('id="cards"');}
});

it('returns broker through real site_state and its field guide',async()=>{
 await content.createItem(db,actor,'site',{broker:'Example Brokerage'},undefined);
 const {token}=await keys.create(db,'Test');
 const response=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'site_state',arguments:{ids:['site']}}})}),env as unknown as Env,{waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext);
 expect(response.status).toBe(200);const rpc:any=await response.json();expect(rpc.result.isError).toBeFalsy();const state=JSON.parse(rpc.result.content[0].text);expect(state.items[0].data.broker).toBe('Example Brokerage');expect(JSON.stringify(state.fields)).toContain('broker');
});
