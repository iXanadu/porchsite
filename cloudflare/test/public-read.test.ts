import {env} from 'cloudflare:workers';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {Env} from '../src/env';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as site from '../src/site';
import * as theme from '../src/theme';
import * as markdown from '../src/agent-markdown';
import * as artifacts from '../src/public-artifacts';
import * as traffic from '../src/agent-traffic';
import * as read from '../src/public-read';
import {handle} from '../src/routes';
const e={...env,PUBLIC_ARTIFACTS:''} as unknown as Env,db=e.DB,origin='https://site.example',who='assistant:test';
beforeEach(async()=>{vi.restoreAllMocks();traffic.reset(db);const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();for(const {name}of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();await db.prepare('INSERT INTO auth_state(id)VALUES(1)').run();});
afterEach(()=>vi.restoreAllMocks());
async function seed(){const s=await content.createItem(db,who,'site',{title:'Approved title',description:'Approved summary',archive:{enabled:true}},undefined);const item=await content.createItem(db,who,'entry',{title:'Entry title',date:'2026-10-17',summary:'Entry summary',body:'Body canary not in metadata'},undefined);await approvals.publishNow(db,[{id:s.id,version:1},{id:item.id,version:1}],'',origin);return item;}
const req=(path:string,headers:Record<string,string>={},method='GET')=>handle(new Request(origin+path,{headers,method}),e);
it('perf_conditional_budget: <=3 statements, zero views/parsing/prepared store/UC9 for matching GET and HEAD',async()=>{
 await seed();expect((await read.facts(db)).hasSite).toBe(true);const r=await req('/');expect(r.status).toBe(200);expect(r.headers.get('ETag')).toMatch(/^W\/"dep1-[a-f0-9]{64}"$/);expect(await r.text()).toContain('"name":"Approved title"');
 const load=vi.spyOn(site,'liveView'),render=vi.spyOn(theme,'render'),copy=vi.spyOn(markdown,'markdownDocument'),snapshot=vi.spyOn(artifacts,'snapshot'),observe=vi.spyOn(traffic,'observe'),sql=vi.spyOn(db,'prepare');
 for(const method of ['GET','HEAD']){sql.mockClear();const hit=await req('/',{'If-None-Match':r.headers.get('ETag')!},method);expect(hit.status).toBe(304);expect(await hit.text()).toBe('');expect(sql.mock.calls.length).toBeLessThanOrEqual(3);expect(sql.mock.calls.every(([q])=>!/^\s*(INSERT|UPDATE|DELETE)/i.test(q))).toBe(true);for(const spy of [load,render,copy,snapshot,observe])expect(spy).not.toHaveBeenCalled();for(const key of ['Content-Type','Cache-Control','Content-Signal','ETag','Vary','Link','Content-Security-Policy'])expect(hit.headers.get(key),key).toBe(r.headers.get(key));}
});
it('perf_missing_budget: path-shaped and unshaped misses never load views or become wildcard 304',async()=>{
 await seed();const load=vi.spyOn(site,'liveView'),sql=vi.spyOn(db,'prepare');
 for(const path of ['/wp-admin/install.php','/journal/absent/','/journal/absent/index.md']){sql.mockClear();const r=await req(path,{'If-None-Match':'*'});expect(r.status).toBe(404);expect(r.headers.has('ETag')).toBe(false);expect(load).not.toHaveBeenCalled();expect(sql.mock.calls.length).toBeLessThanOrEqual(3);}
});
it('perf_stamp_changes: old-runtime-style live version changes invalidate tags while elapsed minutes do not without stored state',async()=>{
 const item=await seed();const first=await req('/');const tag=first.headers.get('ETag')!;
 await db.prepare('UPDATE live SET version=version+1 WHERE item_id=?').bind(item.id).run();const edited=await req('/',{'If-None-Match':tag});expect(edited.status).toBe(200);expect(edited.headers.get('ETag')).not.toBe(tag);
 const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+7200000);const timed=await req('/',{'If-None-Match':edited.headers.get('ETag')!});expect(timed.status).toBe(304);expect(timed.headers.get('ETag')).toBe(edited.headers.get('ETag'));
});
it('perf_one_view_and_metadata: first render reuses a view and produces inert facts without full Markdown projection',async()=>{
 await seed();const load=vi.spyOn(site,'liveView'),copy=vi.spyOn(markdown,'markdownDocument'),sql=vi.spyOn(db,'prepare');const r=await req('/archive/');expect(r.status).toBe(200);expect(load).toHaveBeenCalledTimes(1);expect(copy).not.toHaveBeenCalled();expect(sql.mock.calls.filter(([q])=>q.includes("f.key = 'private'"))).toHaveLength(1);expect(await r.text()).toContain('application/ld+json');
});
it('perf_route_shapes: preserve slash/legacy redirects and search JSON while missing pages stay cheap',async()=>{
 const item=await seed();const updated=await content.updateItem(db,who,'site',1,{theme:'personal-homepage'});await approvals.publishNow(db,[{id:'site',version:updated.version}],'',origin);
 const cases:[string,number][]=[['/journal',301],[`/journal/${item.slug}`,301],[`/e/${item.slug}/`,301],['/journal/search.json',200],['/archive?sort=stream',301],['/archive?sort=invalid',400]];
 for(const [path,status]of cases){const response=await req(path);expect(response.status,path).toBe(status);}
});
it.each(['/','/index.md','/llms.txt'])('perf_private_during_view: invalid Authorization cannot read %s after private-on',async(path)=>{
 await seed();const load=site.liveView;let once=true;
 const reading=vi.spyOn(site,'liveView').mockImplementation(async(...args)=>{if(once){once=false;const hidden=await content.updateItem(db,who,'site',1,{private:true});await approvals.publishNow(db,[{id:'site',version:hidden.version}],'',origin);}return load(...args);});
 const response=await req(path,{Authorization:'Bearer invalid','If-None-Match':'*'});expect(response.status).toBe(404);expect(await response.text()).toBe('<!doctype html><meta name="robots" content="noindex"><title></title>');expect(response.headers.has('ETag')).toBe(false);expect(reading).toHaveBeenCalledTimes(1);
});
it('perf_conditional_race: removal after the first facts read cannot reuse a warm validator',async()=>{
 const item=await seed(),path=`/journal/${item.slug}/`,warm=await req(path),load=read.facts;let calls=0;expect(warm.status).toBe(200);expect(warm.headers.has('ETag')).toBe(true);
 vi.spyOn(read,'facts').mockImplementation(async(db)=>{if(++calls===2){const gone=await content.removeItem(db,who,item.id,item.version);await approvals.publishNow(db,[{id:gone.id,version:gone.version}],'',origin);}return load(db);});
 const response=await req(path,{'If-None-Match':warm.headers.get('ETag')!});expect(response.status).toBe(404);expect(response.headers.has('ETag')).toBe(false);
});
it.each([
 ['notice',{timezone:'America/New_York',notice:{text:'Expires tonight',until:'2026-10-18'}},null,'2026-10-19T03:59:59Z','2026-10-19T04:00:00Z'],
 ['event',{timezone:'America/New_York'}, {start:'2026-11-01T01:15'},'2026-11-01T05:59:59Z','2026-11-01T06:00:00Z'],
] as const)('af_time_native_%s: published clock facts invalidate the public tag at the real boundary',async(_name,data,event,before,after)=>{
 const item=await seed();const updated=await content.updateItem(db,who,'site',1,{theme:'event-page',...data});await approvals.publishNow(db,[{id:'site',version:updated.version}],'',origin);
 if(event){const changed=await content.updateItem(db,who,item.id,1,{event});await approvals.publishNow(db,[{id:item.id,version:changed.version}],'',origin);}
 const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(before));const first=await req('/');expect(first.status).toBe(200);expect(first.headers.has('ETag')).toBe(true);const old=first.headers.get('ETag')!;
 expect((await req('/',{'If-None-Match':old})).status).toBe(304);clock.mockReturnValue(Date.parse(after));const changed=await req('/',{'If-None-Match':old});expect(changed.status).toBe(200);expect(changed.headers.get('ETag')).not.toBe(old);
});
it('af_time_deadline_race: a notice boundary crossed during conditional validation cannot return old304',async()=>{
 await seed();const updated=await content.updateItem(db,who,'site',1,{theme:'local-business',notice:{text:'Expires tonight',until:'2026-10-18'}});await approvals.publishNow(db,[{id:'site',version:updated.version}],'',origin);
 const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-18T23:59:59Z')),first=await req('/'),old=first.headers.get('ETag')!,load=read.facts;let calls=0;
 vi.spyOn(read,'facts').mockImplementation(async(db)=>{const f=await load(db);if(++calls===2)clock.mockReturnValue(Date.parse('2026-10-19T00:00Z'));return f;});
 const changed=await req('/',{'If-None-Match':old});expect(changed.status).toBe(200);expect(changed.headers.get('ETag')).not.toBe(old);expect(await changed.text()).not.toContain('Expires tonight');
});
