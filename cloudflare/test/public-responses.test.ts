import {env} from 'cloudflare:workers';
import {beforeEach,expect,it,vi} from 'vitest';
import {handle} from '../src/routes';
import type {Env} from '../src/env';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as site from '../src/site';
import * as read from '../src/public-read';
import * as cache from '../src/public-responses';
import * as artifacts from '../src/public-artifacts';
import * as traffic from '../src/agent-traffic';
import {PUBLIC_CACHE} from '../src/public-http';
import keys from '../../spec/fixtures/public-response-keys.json';
const origin='https://site.example',e={...env,SITE_URL:origin,PUBLIC_RESPONSES:'1'} as unknown as Env,db=e.DB;
let rows:Map<string,Response>;
const address=(request:RequestInfo|URL)=>typeof request==='string'?request:request instanceof URL?request.href:request.url;
beforeEach(async()=>{
 vi.restoreAllMocks();vi.useRealTimers();traffic.reset(db);rows=new Map();
 vi.spyOn(caches.default,'match').mockImplementation(async request=>rows.get(address(request))?.clone());
 vi.spyOn(caches.default,'put').mockImplementation(async(request,response)=>{rows.set(address(request),response.clone());});
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name} of tables.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();
});
async function publish(item:content.Item){await approvals.publishNow(db,[{id:item.id,version:item.version}],'',origin);}
async function fixture(){const one=await content.createItem(db,'assistant:test','site',{title:'Response cache',theme:'personal-homepage',archive:{enabled:true,title:'Pages'}},undefined);await publish(one);const entry=await content.createItem(db,'assistant:test','entry',{title:'Entry',date:'2026-10-17',body:'Public body.'},undefined);await publish(entry);return {one,entry};}
const get=(path='/',headers:Record<string,string>={},method='GET',settings=e)=>handle(new Request(origin+path,{headers,method}),settings);
it('perf4_hit_identity: body and outward headers are fresh policy; HEAD/304 avoid render and fills',async()=>{
 await fixture();const first=await get(),body=await first.text();expect(rows.size).toBe(1);
 const view=vi.spyOn(site,'liveView').mockImplementation(async()=>{throw Error('HIT rendered');});
 const artifact=vi.spyOn(artifacts,'respond').mockImplementation(async()=>{throw Error('HIT entered artifacts');});
 const observe=vi.spyOn(traffic,'observe');
 // Backend age/cache retention is never outward response policy.
 for(const row of rows.values())row.headers.set('Age','300');
 const hit=await get('/',{Origin:'https://other.example'});expect(await hit.text()).toBe(body);expect([...hit.headers]).toEqual([...first.headers]);expect(hit.headers.get('Cache-Control')).toBe(PUBLIC_CACHE);expect(hit.headers.has('Age')).toBe(false);
 const head=await get('/',{},'HEAD');expect(await head.text()).toBe('');expect([...head.headers]).toEqual([...first.headers]);
 const reads=vi.mocked(caches.default.match).mock.calls.length,puts=vi.mocked(caches.default.put).mock.calls.length;
 expect((await get('/',{'If-None-Match':first.headers.get('ETag')!})).status).toBe(304);
 expect(vi.mocked(caches.default.match).mock.calls.length).toBe(reads);expect(vi.mocked(caches.default.put).mock.calls.length).toBe(puts);
 expect(view).not.toHaveBeenCalled();expect(artifact).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();
});
it('perf4_gate_before_cache: every credential form, Range, wrong origin and private bypass cache operations',async()=>{
 const {one}=await fixture();await get();vi.mocked(caches.default.match).mockClear();vi.mocked(caches.default.put).mockClear();
 for(const headers of ([{Authorization:''},{Authorization:'Bearer invalid'},{Cookie:'__Host-sk_owner='},{Cookie:'__Host-sk_reader=expired'},{Range:'bytes=0-3'}] as Record<string,string>[]))await get('/',headers);
 await get('/',{},'GET',{...e,SITE_URL:'https://different.example'});
 expect(caches.default.match).not.toHaveBeenCalled();expect(caches.default.put).not.toHaveBeenCalled();
 await publish(await content.updateItem(db,'assistant:test','site',one.version,{private:true}));
 expect((await get()).status).toBe(404);expect(caches.default.match).not.toHaveBeenCalled();expect(caches.default.put).not.toHaveBeenCalled();
});
it('perf4_key_identity: direct and selected Markdown share only body identity; headers stay request-shaped',async()=>{
 await fixture();const direct=await get('/index.md'),body=await direct.text();expect(direct.headers.has('Vary')).toBe(false);
 const view=vi.spyOn(site,'liveView').mockImplementation(async()=>{throw Error('markdown HIT rendered');});
 const hit=await get('/',{Accept:'text/markdown'});expect(await hit.text()).toBe(body);expect(hit.headers.get('Vary')).toBe('Accept');expect(rows.size).toBe(1);expect(view).not.toHaveBeenCalled();
 for(const row of keys){const request=await cache.key(row.origin,row.release,row.choice as read.Choice,row.tag);expect(request!.url).toBe(row.key);expect(request!.method).toBe('GET');expect([...request!.headers]).toEqual([]);}
});
it('perf4_hit_race: final facts refuse private-on and old-runtime removal during match',async()=>{
 const {one}=await fixture();await get();let once=true;
 vi.mocked(caches.default.match).mockImplementation(async request=>{const found=rows.get(address(request))?.clone();if(once){once=false;await publish(await content.updateItem(db,'assistant:test','site',one.version,{private:true}));}return found;});
 const answer=await get();expect(answer.status).toBe(404);expect(await answer.text()).not.toContain('Public body.');
});
it('perf4_previous_runtime: a write without invalidation changes the immutable key',async()=>{
 const {entry}=await fixture();await get();const first=[...rows.keys()];
 await db.prepare('UPDATE live SET data=json_set(data,\'$.title\',\'Changed by previous runtime\'),version=version+1 WHERE item_id=?').bind(entry.id).run();
 const answer=await get();expect(await answer.text()).toContain('Changed by previous runtime');expect([...rows.keys()].some(k=>!first.includes(k))).toBe(true);
});
it('perf4_put_race: queued fill rechecks facts and skips storage after private-on',async()=>{
 const {one}=await fixture();const original=read.facts;let calls=0;
 vi.spyOn(read,'facts').mockImplementation(async(...args)=>{calls++;if(calls===3)await publish(await content.updateItem(db,'assistant:test','site',one.version,{private:true}));return original(...args);});
 await get();expect(caches.default.put).not.toHaveBeenCalled();expect((await get()).status).toBe(404);
});
it('perf4_storage_limits: corrupt digest, expiry and rejected operations are safe misses',async()=>{
 await fixture();const body=await(await get()).text();
 for(const mutation of ['body','expired','headers']){
  const [address,row]=[...rows][0],meta=JSON.parse(row.headers.get('x-porchsite-response')!);
  if(mutation==='expired')meta[3]=0;
  const h=new Headers(row.headers);h.set('x-porchsite-response',JSON.stringify(meta));if(mutation==='headers')h.set('Set-Cookie','private=1');
  rows.set(address,new Response(mutation==='body'?'corrupt':await row.clone().text(),{headers:h}));
  const view=vi.spyOn(site,'liveView');expect(await(await get()).text()).toBe(body);expect(view).toHaveBeenCalled();view.mockRestore();
 }
 vi.mocked(caches.default.match).mockRejectedValue(Error('offline'));vi.mocked(caches.default.put).mockRejectedValue(Error('offline'));expect(await(await get()).text()).toBe(body);
 const long=new Response('x'.repeat(cache.MAX_BODY+1));expect(await cache.boundedBody(long)).toBeNull();
});
it('perf4_counts: cache hits neither count nor flush, including AF-7T and default-off',async()=>{
 await fixture();const observe=vi.spyOn(traffic,'observe');await get('/',{},'GET',{...e,PUBLIC_ARTIFACTS:'1'});expect(observe).toHaveBeenCalledTimes(1);observe.mockClear();
 await get('/',{},'GET',{...e,PUBLIC_ARTIFACTS:'1'});expect(observe).not.toHaveBeenCalled();
 await get('/',{},'GET',{...e,PUBLIC_RESPONSES:''});expect(observe).toHaveBeenCalledTimes(1);
 expect(traffic.CLASSIFICATION.coverage).toContain('response-cache hits');
});
it('perf4_storage_clock: exclusive expiry and clock rollback reject the old record',async()=>{
 await fixture();let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
 await get();const original=[...rows.values()][0].clone(),view=vi.spyOn(site,'liveView');
 const metadata=JSON.parse(original.headers.get('x-porchsite-response')!);now=metadata[3];await get();expect(view).toHaveBeenCalled();view.mockClear();
 rows.set([...rows.keys()][0],original);now=metadata[2]-1;await get();expect(view).toHaveBeenCalled();
});
it('perf4_capacity: two pending fills bound cloned background work',async()=>{
 await fixture();let release!:()=>void;const pending=new Promise<void>(resolve=>release=resolve),tasks:Promise<unknown>[]=[];
 vi.mocked(caches.default.put).mockImplementation(async()=>pending);
 const ctx={waitUntil:(task:Promise<unknown>)=>{tasks.push(task);}};
 try{for(let i=0;i<3;i++)await handle(new Request(origin+'/'),e,ctx);await vi.waitFor(()=>expect(caches.default.put).toHaveBeenCalledTimes(2));}
 finally{release();await Promise.all(tasks);}
});
it('perf4_default_off: only the exact independent operator flag and configured origin enable reuse',async()=>{
 await fixture();for(const value of ['', '0','true','yes','01'])await get('/',{},'GET',{...e,PUBLIC_RESPONSES:value});
 await get('/',{},'GET',{...e,SITE_URL:undefined});
 expect(caches.default.match).not.toHaveBeenCalled();expect(caches.default.put).not.toHaveBeenCalled();
});
it('perf4_synthetic_key: the storage address is not a public route',async()=>{
 await fixture();await get();const address=[...rows.keys()][0];vi.mocked(caches.default.match).mockClear();
 const response=await handle(new Request(address),e);expect(response.status).toBe(404);expect(await response.text()).not.toContain('Public body.');expect(caches.default.match).not.toHaveBeenCalled();
});
it('perf4_hit_race_unpublish: page existence is rechecked after the asynchronous match',async()=>{
 const {entry}=await fixture(),f=await read.facts(db),page=f.entries.find(x=>x.id===entry.id)!.page;await get(page);
 vi.mocked(caches.default.match).mockImplementation(async request=>{const found=rows.get(address(request))?.clone();await db.prepare('DELETE FROM live WHERE item_id=?').bind(entry.id).run();return found;});
 const answer=await get(page);expect(answer.status).toBe(404);expect(await answer.text()).not.toContain('Public body.');
});
