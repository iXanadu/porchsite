import {env} from 'cloudflare:workers';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as site from '../src/site';
import * as read from '../src/public-read';
import * as traffic from '../src/agent-traffic';
import {handle} from '../src/routes';
import type {Env} from '../src/env';
const e={...env,PUBLIC_ARTIFACTS:''} as unknown as Env,db=e.DB,origin='https://site.example',who='assistant:test';
beforeEach(async()=>{vi.restoreAllMocks();traffic.reset(db);const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();for(const {name}of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();await db.prepare('INSERT INTO auth_state(id)VALUES(1)').run();});
afterEach(()=>vi.restoreAllMocks());
async function seed(){const s=await content.createItem(db,who,'site',{title:'Approved title',archive:{enabled:true}},undefined),i=await content.createItem(db,who,'entry',{title:'Entry',date:'2026-10-17',body:'Published body'},undefined);await approvals.publishNow(db,[{id:s.id,version:1},{id:i.id,version:1}],'',origin);return i;}
const req=(headers:Record<string,string>={})=>handle(new Request(origin+'/',{headers}),e);
it('perf5_public_proof_budget: reuse approved source/share metadata with final proof and existing live body read',async()=>{
 await seed();const load=vi.spyOn(site,'liveView'),facts=vi.spyOn(read,'facts'),sql=vi.spyOn(db,'prepare');const r=await req();expect(r.status).toBe(200);expect(await r.text()).toContain('Approved title');expect(load).toHaveBeenCalledTimes(1);expect(load.mock.calls[0][2]?.siteRows.length).toBeGreaterThan(0);expect(facts).toHaveBeenCalledTimes(2);
 const queries=sql.mock.calls.map(([q])=>q),writes=queries.filter(q=>/^\s*(INSERT|UPDATE|DELETE)/i.test(q));expect(queries.length-writes.length).toBeLessThanOrEqual(5);expect(writes.length).toBeLessThanOrEqual(1);expect(writes.every(q=>q.startsWith('INSERT INTO agent_traffic_daily'))).toBe(true);expect(sql.mock.calls.some(([q])=>q.includes('SELECT l.*, i.created_at'))).toBe(true);expect(sql.mock.calls.some(([q])=>q.includes('SELECT item_id, version, name FROM share_cards'))).toBe(false);expect(sql.mock.calls.some(([q])=>q.includes('SELECT sources, approved FROM site_embed_sources WHERE version'))).toBe(false);
});
const credentials:Record<string,string>[]=[{Authorization:''},{Authorization:'Bearer invalid'},{Cookie:'__Host-sk_owner=invalid'},{Cookie:'__Host-sk_reader=invalid'}];
it.each(credentials)('perf5_credential_bypass: no public-proof metadata for %s',async headers=>{
 await seed();const load=vi.spyOn(site,'liveView'),proof=vi.spyOn(read,'viewProof');await req(headers);expect(load).toHaveBeenCalled();expect(load.mock.calls.every(c=>c[2]===undefined)).toBe(true);expect(proof).not.toHaveBeenCalled();
});
it('perf5_version_and_raw_match: same-version raw edits fall back to current source reads',async()=>{
 await seed();const proof=read.viewProof(await read.facts(db))!;await db.prepare("UPDATE live SET data=json_set(data,'$.title','Current same-version title') WHERE item_id='site'").run();const sql=vi.spyOn(db,'prepare');const v=await site.liveView(db,false,proof);expect(v.site.title).toBe('Current same-version title');expect(sql.mock.calls.some(([q])=>q.includes('SELECT sources, approved FROM site_embed_sources WHERE version'))).toBe(true);
});
it('perf5_share_version: only current matching item versions survive reuse',async()=>{
 const item=await seed(),name='a'.repeat(32)+'.jpg';await db.prepare("INSERT INTO share_cards(item_id,version,name,created_at)VALUES(?,?,?,'2026-10-17')").bind(item.id,2,name).run();let proof=read.viewProof(await read.facts(db))!;expect((await site.liveView(db,false,proof)).share_cards).toEqual({});await db.prepare('UPDATE share_cards SET version=1').run();proof=read.viewProof(await read.facts(db))!;expect((await site.liveView(db,false,proof)).share_cards).toEqual({[item.id]:'/media/'+name});
});
it('perf5_extension_race: same-version approved extension changes discard the old view and refresh the proof',async()=>{
 await seed();const original=read.facts;let calls=0;vi.spyOn(read,'facts').mockImplementation(async db=>{const f=await original(db);if(++calls===1){const row=await db.prepare('SELECT settings FROM site_stream_settings WHERE version=1').first<{settings:string}>();const data=JSON.parse(row!.settings);data.streams[0].title='Fresh approved stream';data.streams[0].nav_label='Fresh approved stream';await db.prepare('UPDATE site_stream_settings SET settings=? WHERE version=1').bind(JSON.stringify(data)).run();}return f;});const load=vi.spyOn(site,'liveView');const r=await req();expect(r.status).toBe(200);expect(await r.text()).toContain('Fresh approved stream');expect(load).toHaveBeenCalledTimes(2);expect(load.mock.calls[0][2]?.siteRows).not.toEqual(load.mock.calls[1][2]?.siteRows);
});
it('perf5_private_race: current private receipt blocks bytes even when the original public proof was reusable',async()=>{
 await seed();const original=site.liveView;let once=true;vi.spyOn(site,'liveView').mockImplementation(async(...args)=>{if(once){once=false;await db.prepare("INSERT INTO site_fields(version,key,value,approved)VALUES(1,'private','true',1) ON CONFLICT(version,key) DO UPDATE SET value='true',approved=1").run();await db.prepare('INSERT OR IGNORE INTO private_approvals(version)VALUES(1)').run();}return original(...args);});const r=await req();expect(r.status).toBe(404);expect(await r.text()).toBe('<!doctype html><meta name="robots" content="noindex"><title></title><a href="/login?next=%2Freview">Sign in</a>');expect(r.headers.has('ETag')).toBe(false);
});
it('perf5_source_rules: malformed approved stream settings retain the isolated decoder refusal',async()=>{
 await seed();await db.prepare(`UPDATE site_stream_settings SET settings='{"title":"Injected owner string"}' WHERE version=1`).run();expect(()=>read.viewProof({rows:[['live','site',['site',null,1,'','',null,null,null,{}]],['streams','site',[{title:'Injected owner string'},1]]],private:false,hasSite:true,site:{},entries:[],themed:false,disabled:false})).toThrow('Stored stream settings do not validate');
});
