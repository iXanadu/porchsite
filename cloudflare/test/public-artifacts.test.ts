// AF-7 acceptance; paired with server/tests/app/test_public_artifacts.py.
import {env} from 'cloudflare:workers';
import {beforeEach,expect,it,vi} from 'vitest';
import type {Env} from '../src/env';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as site from '../src/site';
import * as artifacts from '../src/public-artifacts';
import * as read from '../src/public-read';
import * as traffic from '../src/agent-traffic';
import {handle} from '../src/routes';
import {BLANK,SIGN_IN} from '../src/privacy';
import {SoftKey} from './softkey';
const origin='https://site.example',actor='assistant:test',base=env as unknown as Env,e={...base,SITE_URL:origin,PUBLIC_ARTIFACTS:'1'},db=e.DB;
beforeEach(async()=>{
 vi.restoreAllMocks();vi.useRealTimers();traffic.reset(db);
 const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name} of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();
});
async function publish(item:content.Item){await approvals.publishNow(db,[{id:item.id,version:item.version}],'',origin);}
async function fixture(){
 const one=await content.createItem(db,actor,'site',{title:'Prepared fixture',theme:'personal-homepage',archive:{enabled:true,title:'All pages'}},undefined);await publish(one);
 const entry=await content.createItem(db,actor,'entry',{title:'First page',date:'2026-10-17',body:'Published body.',tags:['tag']},undefined);await publish(entry);return {one,entry};
}
const get=(path='/',headers:Record<string,string>={},method='GET')=>handle(new Request(origin+path,{method,headers}),e);
async function count(){return Number(await db.prepare('SELECT count(*) AS n FROM public_artifacts').first('n'));}
it('af_prebuild_bytes: a warm representation avoids rendering and preserves all body/tag metadata',async()=>{
 await fixture();const first=await get(),body=await first.text(),tag=first.headers.get('ETag');expect(await count()).toBe(1);
 const liveHead=await handle(new Request(origin+'/',{method:'HEAD'}),{...e,PUBLIC_ARTIFACTS:undefined});expect(await liveHead.text()).toBe('');expect([...liveHead.headers]).toEqual([...first.headers]);
 const render=vi.spyOn(site,'liveView').mockImplementation(async()=>{throw Error('warm hit rendered');});
 const warm=await get();expect(await warm.text()).toBe(body);expect([...warm.headers]).toEqual([...first.headers]);expect(render).not.toHaveBeenCalled();
 const conditional=await get('/',{'If-None-Match':tag!});expect(conditional.status).toBe(304);expect(await conditional.text()).toBe('');
 const head=await get('/',{},'HEAD');expect(head.status).toBe(200);expect(await head.text()).toBe('');expect([...head.headers]).toEqual([...first.headers]);
});
it('af_prebuild_negotiation: copy and negotiated bodies/tags share storage, delivery Vary stays distinct',async()=>{
 await fixture();const direct=await get('/index.md'),body=await direct.text(),tag=direct.headers.get('ETag');expect(await count()).toBe(1);expect(direct.headers.has('Vary')).toBe(false);
 const render=vi.spyOn(site,'liveView').mockImplementation(async()=>{throw Error('copy warm hit rendered');});
 const selected=await get('/',{Accept:'text/markdown'});expect(await selected.text()).toBe(body);expect(selected.headers.get('ETag')).toBe(tag);expect(selected.headers.get('Vary')).toBe('Accept');expect(await count()).toBe(1);expect(render).not.toHaveBeenCalled();
 render.mockRestore();const refused=await get('/',{Accept:'text/plain;q=1,text/html;q=0,text/markdown;q=0'});expect(refused.status).toBe(406);expect(await count()).toBe(1);
});
it('af_prebuild_dependency_matrix: public changes clear copies atomically; drafts and accounting do not',async()=>{
 const {one}=await fixture();await get();const stamp=await artifacts.snapshot(db);
 const draft=await content.updateItem(db,actor,'site',one.version,{title:'Changed title'});expect(await artifacts.snapshot(db)).toBe(stamp);expect(await count()).toBe(1);
 await get();expect(await count()).toBe(1);await publish(draft);expect(await count()).toBe(0);expect(await(await get()).text()).toContain('Changed title');
 const blocked=await content.updateItem(db,actor,'site',draft.version,{ai_training_disabled:true});await publish(blocked);expect(await count()).toBe(0);expect((await get()).headers.get('Content-Signal')).toContain('ai-train=no');
});
it('af_prebuild_publication_atomic: invalidation failure rolls publication back',async()=>{
 const {one}=await fixture();await get();const draft=await content.updateItem(db,actor,'site',one.version,{title:'Must not publish'});
 await db.prepare("CREATE TRIGGER fail_artifact_delete BEFORE DELETE ON public_artifacts BEGIN SELECT RAISE(ABORT,'artifact delete failure'); END").run();
 try{await expect(publish(draft)).rejects.toThrow();expect(await db.prepare("SELECT version FROM live WHERE item_id='site'").first('version')).toBe(one.version);expect(await count()).toBe(1);}
 finally{await db.prepare('DROP TRIGGER fail_artifact_delete').run();}
});
it('af_prebuild_gate_first: private and credentialed requests never look up prepared copies',async()=>{
 const {one}=await fixture();await get();const cache=vi.spyOn(artifacts,'respond');
 for(const headers of ([{Authorization:'Bearer fixture'},{Cookie:'__Host-sk_owner=expired'},{Cookie:'__Host-sk_reader=revoked'}] as Record<string,string>[])){
  const r=await get('/',headers);expect(r.headers.get('Cache-Control')).toContain('no-store');expect(r.headers.has('ETag')).toBe(false);
 }
 expect(await count()).toBe(1);const privateSite=await content.updateItem(db,actor,'site',one.version,{private:true});await publish(privateSite);expect(await count()).toBe(0);cache.mockClear();
 for(const path of ['/','/index.md','/llms.txt','/missing/index.md'])for(const headers of ([{},{Cookie:'__Host-sk_owner=expired'},{Authorization:'Bearer fixture'}] as Record<string,string>[])){
  const r=await get(path,{...headers,Accept:'text/markdown','If-None-Match':'*'});expect(r.status).toBe(404);expect(await r.text()).toBe(headers.Authorization?BLANK:SIGN_IN);expect(r.headers.has('ETag')).toBe(false);
 }
 expect(cache).not.toHaveBeenCalled();expect(await count()).toBe(0);
});
it('af_prebuild_races: private-on discards a builder already holding a public snapshot',async()=>{
 const {one}=await fixture();const original=site.liveView;let entered!:()=>void,resume!:()=>void;
 const started=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>resume=r);let once=true;
 const render=vi.spyOn(site,'liveView').mockImplementation(async(...args)=>{const view=await original(...args);if(once){once=false;entered();await barrier;}return view;});
 const pending=get();await started;
 const hidden=await content.updateItem(db,actor,'site',one.version,{private:true});await publish(hidden);resume();
 const response=await pending;expect(response.status).toBe(404);expect(await response.text()).toBe(SIGN_IN);expect(await count()).toBe(0);render.mockRestore();
});
it('af_prebuild_clock: expired intervals are reclaimed before the next fill',async()=>{
 await fixture();await get();await db.prepare('UPDATE public_artifacts SET valid_until=0').run();
 const render=vi.spyOn(site,'liveView');expect((await get()).status).toBe(200);expect(render).toHaveBeenCalled();expect(await count()).toBe(1);
 expect(artifacts.displayBoundary(Date.UTC(2026,10,1,5,59,59))).toBe(Date.UTC(2026,10,2,5,59,59));
});
it('af_prebuild_bounded_failure: invalid headers and absent storage fall back to safe live rendering',async()=>{
 await fixture();const first=await get(),body=await first.text();
 await db.prepare('UPDATE public_artifacts SET metadata=?').bind(JSON.stringify([['set-cookie','secret=1']])).run();
 const repaired=await get();expect(await repaired.text()).toBe(body);expect(repaired.headers.has('Set-Cookie')).toBe(false);
 // A backend outage is represented by a rejected artifact lookup, not by a failed access check.
 await db.prepare('ALTER TABLE public_artifacts RENAME TO unavailable_artifacts').run();
 try{expect((await get('/index.md')).status).toBe(200);}finally{await db.prepare('ALTER TABLE unavailable_artifacts RENAME TO public_artifacts').run();}
 expect(artifacts.configuredOrigin('https://user:pass@example.com')).toBeNull();expect(artifacts.configuredOrigin('https://example.com/path')).toBeNull();
});
it('af_prebuild_bounded_failure: unconfigured and unrelated origins never fill storage',async()=>{
 await fixture();const r=await handle(new Request(origin),base);expect(r.status).toBe(200);expect(await count()).toBe(0);
 await handle(new Request('https://other.example/'),e);expect(await count()).toBe(0);
});

it('af_prebuild_accounting: bounded preparation uses anonymous rendering without synthetic traffic',async()=>{
 await fixture();const {preparePublic}=await import('../src/routes');await preparePublic(e);expect(await count()).toBeGreaterThan(0);
 expect(Number(await db.prepare('SELECT COALESCE(sum(requests),0) AS n FROM agent_traffic_daily').first('n'))).toBe(0);
 await get();expect(Number(await db.prepare('SELECT sum(requests) AS n FROM agent_traffic_daily').first('n'))).toBe(1);
});
it('af_prebuild_bounded_failure: count limits do not truncate live responses and expired rows release the budget',async()=>{
 await fixture();await get();const row=await db.prepare('SELECT generation,metadata,valid_until FROM public_artifacts LIMIT 1').first<any>();await db.prepare('DELETE FROM public_artifacts').run();
 await db.batch(Array.from({length:128},(_,i)=>db.prepare('INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size) VALUES(?,?,?, ?,?,?)').bind('occupied-'+i,row.generation,'x',row.metadata,row.valid_until,1)));
 const md=await get('/index.md');expect(md.status).toBe(200);expect((await md.text()).length).toBeGreaterThan(30);expect(await count()).toBe(128);
 await db.prepare('UPDATE public_artifacts SET valid_until=0').run();await get('/index.md');expect(await count()).toBe(1);
});
it('af_prebuild_bytes: corrupted body/tag pairs are discarded rather than served',async()=>{
 await fixture();const expected=await(await get()).text();await db.prepare("UPDATE public_artifacts SET body='CORRUPTED BODY'").run();expect(await(await get()).text()).toBe(expected);
});

it('af_prebuild_clock: DST fallback refreshes displayed hours at the exact minute boundary',async()=>{
 const {one}=await fixture();const hours=await content.updateItem(db,actor,'site',one.version,{theme:'local-business',timezone:'America/New_York',hours:{weekly:[{day:'sun',open:'01:00',close:'01:30'}]}});await publish(hours);
 vi.useFakeTimers({toFake:['Date']});
 try{
  vi.setSystemTime(new Date('2026-11-01T05:59:30Z'));const before=await get();const closed=await before.text();expect(closed).toContain('Closed now');expect(await count()).toBe(1);
  vi.setSystemTime(new Date('2026-11-01T06:00:00Z'));const after=await get('/',{'If-None-Match':before.headers.get('ETag')!});expect(after.status).toBe(200);expect(await after.text()).toContain('Open now');expect(after.headers.get('ETag')).not.toBe(before.headers.get('ETag'));expect(await count()).toBe(1);
 }finally{vi.useRealTimers();}
});

it('af_prebuild_bytes: shared snapshot fixtures fix the cross-edition digest encoding',async()=>{
 const {default:cases}=await import('../../spec/fixtures/public-artifacts.json');
 for(const c of cases)expect(await artifacts.digest(JSON.stringify([artifacts.FORMAT,'fixture','https://example.com',artifacts.normalizedState(JSON.stringify(c.state))])),c.name).toBe(c.sha256);
});
it('af_prebuild_bounded_failure: oversized valid bodies remain live and are never truncated or stored',async()=>{
 await fixture();const request=new Request(origin+'/guide/large/');const body='x'.repeat(artifacts.MAX_BODY+1);
 const {publicResponse}=await import('../src/public-http');
 const response=await artifacts.respond(db,request,origin,'test',()=>publicResponse(db,request,new Response(body,{headers:{'Content-Type':'text/html; charset=utf-8'}})));
 expect(response.status).toBe(200);expect(await response.text()).toBe(body);expect(await count()).toBe(0);
});
it('af_prebuild_gate_first: a private site cannot start public preparation',async()=>{
 const {one}=await fixture();const hidden=await content.updateItem(db,actor,'site',one.version,{private:true});await publish(hidden);
 const {preparePublic}=await import('../src/routes');const render=vi.spyOn(site,'liveView');await preparePublic(e);expect(render).not.toHaveBeenCalled();expect(await count()).toBe(0);
});

it('af_prebuild_dependency_matrix: unpublish, card visibility and restore invalidate every representation',async()=>{
 const {entry}=await fixture();const path='/journal/'+entry.slug+'/';await get(path);await get('/index.md');await get('/llms.txt');expect(await count()).toBe(3);
 const gone=await content.removeItem(db,actor,entry.id,entry.version);expect(await count()).toBe(3);await publish(gone);expect(await count()).toBe(0);expect((await get(path)).status).toBe(404);
 const restored=await content.restore(db,actor,gone.id,gone.version,entry.data,false,'Restore published page');await publish(restored);expect((await get(path)).status).toBe(200);
 const card=await content.createItem(db,actor,'card',{name:'Visible label',description:'Visible detail',visibility:'public'},undefined);await publish(card);await get();
 const hidden=await content.updateItem(db,actor,card.id,card.version,{visibility:'private'});await publish(hidden);expect(await count()).toBe(0);expect(await(await get()).text()).not.toContain('Visible label');
});
it('af_prebuild_dependency_matrix: share-card writes and theme replacement clear stored bodies',async()=>{
 const {entry}=await fixture();await get();const before=await artifacts.snapshot(db);
 const cards=await import('../src/sharecards');const jpeg=Uint8Array.from([255,216,255,192,0,17,8,2,118,4,176,...Array(64).fill(7)]);
 await cards.save(db,entry.id,entry.version,jpeg);expect(await count()).toBe(0);expect(await artifacts.snapshot(db)).not.toBe(before);await get();
 const {THEMES}=await import('../src/themes.gen'),themes=await import('../src/themes');const base=THEMES['personal-homepage'];
 const pkg=JSON.stringify({...base,pages:{...base.pages,home:base.pages.home+'\n'}}),sum=await artifacts.digest(pkg);
 await themes.install(db,'personal-homepage',actor,async url=>String(url)===themes.CATALOG_URL?Response.json({themes:[{name:'personal-homepage',package:{url:'https://catalog.example/look.json',sha256:sum}}]}):new Response(pkg));
 expect(await count()).toBe(0);expect(await artifacts.snapshot(db)).not.toBe(before);
});
it('af_prebuild_bounded_failure: the byte budget refuses a fill without changing its response',async()=>{
 await fixture();const first=await get(),body=await first.text(),row=await db.prepare('SELECT * FROM public_artifacts LIMIT 1').first<any>();await db.prepare('DELETE FROM public_artifacts').run();
 const chunk='x'.repeat(artifacts.MAX_BODY);await db.batch(Array.from({length:16},(_,i)=>db.prepare('INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size) VALUES(?,?,?,?,?,?)').bind('large-'+i,row.generation,chunk,row.metadata,row.valid_until,artifacts.MAX_BODY)));
 expect(await(await get()).text()).toBe(body);expect(await count()).toBe(16);
});
it('af_prebuild_bounded_failure: concurrent fills cannot exceed the row budget',async()=>{
 await fixture();await get();const row=await db.prepare('SELECT * FROM public_artifacts LIMIT 1').first<any>();await db.prepare('DELETE FROM public_artifacts').run();
 await db.batch(Array.from({length:127},(_,i)=>db.prepare('INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size) VALUES(?,?,?,?,?,?)').bind('occupied-'+i,row.generation,'x',row.metadata,row.valid_until,1)));
 const replies=await Promise.all(['/','/index.md','/llms.txt','/journal/'].map(path=>get(path)));expect(replies.map(r=>r.status)).toEqual([200,200,200,200]);expect(await count()).toBe(128);
});
it('af_prebuild_bounded_failure: stored policy and discovery headers cannot be replaced by arbitrary values',async()=>{
 await fixture();const first=await get(),body=await first.text();
 for(const [name,value] of [['content-security-policy',"default-src *; script-src 'unsafe-inline'"],['permissions-policy','camera=*'],['link','<https://outside.example/>; rel="alternate"']]){
  const row=await db.prepare('SELECT metadata FROM public_artifacts LIMIT 1').first<string>('metadata');const pairs=JSON.parse(row!);await db.prepare('UPDATE public_artifacts SET metadata=?').bind(JSON.stringify(pairs.map(([k,v]:string[])=>[k,k===name?value:v]))).run();
  const repaired=await get();expect(await repaired.text()).toBe(body);expect(repaired.headers.get(name)).toBe(first.headers.get(name));
 }
});
it('af_prebuild_negotiation: configured origins have identical normalized grammar',async()=>{
 const {default:cases}=await import('../../spec/fixtures/public-artifact-origins.json');for(const c of cases)expect(artifacts.configuredOrigin(c.value),c.value).toBe(c.origin);
});
it('af_prebuild_bounded_failure: delivery and preparation stay off without explicit opt-in; invalidation remains active',async()=>{
 const {one}=await fixture();const {preparePublic}=await import('../src/routes');for(const flag of [undefined,'','0','true','2']){const off={...e,PUBLIC_ARTIFACTS:flag};const response=await handle(new Request(origin+'/?PUBLIC_ARTIFACTS=1',{headers:{PUBLIC_ARTIFACTS:'1'}}),off);expect(response.status).toBe(200);await preparePublic(off);expect(await count()).toBe(0);}
 await get();expect(await count()).toBe(1);const draft=await content.updateItem(db,actor,'site',one.version,{title:'Approved new title'});await publish(draft);expect(await count()).toBe(0);
});
it('af_prebuild_no_owner_bytes: valid owner/reader sessions bypass warmed copies and never contaminate them',async()=>{
 const {one}=await fixture();const visitor=await(await get()).text();
 const hash=async(token:string)=>btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 await db.prepare("INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,'2026-10-17','2099-01-01')").bind(await hash('owner-fixture')).run();
 await db.prepare("INSERT INTO readers(id,name,created_at) VALUES('reader','Reader','2026-10-17')").run();await db.prepare("INSERT INTO reader_passkeys(id,reader_id,public_key,created_at) VALUES('reader-key','reader',?,'2026-10-17')").bind(new Uint8Array([0])).run();
 await db.prepare("INSERT INTO reader_sessions(token_hash,reader_id,credential_id,epoch,created_at,expires_at) VALUES(?,'reader','reader-key',0,'2026-10-17','2099-01-01')").bind(await hash('reader-fixture')).run();
 for(const [token,role] of [['owner-fixture','owner'],['reader-fixture','reader']]){
  const headers={Cookie:`__Host-sk_${role}=${token}`},html=await get('/',headers),body=await html.text();expect(html.headers.get('Cache-Control')).toContain('no-store');expect(html.headers.has('ETag')).toBe(false);expect(body.includes('sk-owner-link')).toBe(role==='owner');
  const md=await get('/index.md',headers);expect(md.headers.has('ETag')).toBe(false);expect(await md.text()).not.toContain('/review');
  for(const path of ['/nowhere/','/wp-admin/install.php']){const missing=await get(path,headers);expect(missing.status).toBe(404);expect((await missing.text()).includes('sk-owner-link')).toBe(role==='owner');expect(missing.headers.get('Cache-Control')).toContain('no-store');expect(missing.headers.has('ETag')).toBe(false);}
 }
 expect(await count()).toBe(1);expect(await(await get()).text()).toBe(visitor);
 const rows=await db.prepare('SELECT body,metadata FROM public_artifacts').all<{body:string;metadata:string}>();expect(JSON.stringify(rows.results)).not.toContain('sk-owner-link');expect(JSON.stringify(rows.results)).not.toContain('/review');
 const hidden=await content.updateItem(db,actor,'site',one.version,{private:true});await publish(hidden);
 const privateTags=new Set<string>();
 for(const role of ['owner','reader']){const cookie={Cookie:`__Host-sk_${role}=${role}-fixture`};expect((await get('/',cookie)).status).toBe(200);const copy=await get('/index.md',cookie);expect(copy.status).toBe(200);expect(copy.headers.get('Cache-Control')).toBe('private, no-cache, must-revalidate, no-transform');const tag=copy.headers.get('ETag')!;expect(tag).toMatch(/^W\/"ag-sha256-[a-f0-9]{64}"$/);privateTags.add(tag);expect(await copy.text()).not.toContain('/review');expect((await get('/index.md',{...cookie,'If-None-Match':tag})).status).toBe(304);}
 expect(privateTags.size).toBe(2);
 for(const headers of [{},{Authorization:'Bearer psk_unknown'},{Authorization:'Bearer prk_unknown'},{Cookie:'__Host-sk_owner=expired'}] as Record<string,string>[]){const denied=await get('/index.md',headers);expect(denied.status).toBe(404);expect(await denied.text()).toBe(Object.hasOwn(headers,'Authorization')?BLANK:SIGN_IN);expect(denied.headers.has('ETag')).toBe(false);}
 expect(await count()).toBe(0);
});
it('af_prebuild_races: an entry removed during rendering cannot be filled or delivered',async()=>{
 const {entry}=await fixture();const original=site.liveView;let entered!:()=>void,resume!:()=>void;const started=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>resume=r);let once=true;
 vi.spyOn(site,'liveView').mockImplementation(async(...args)=>{const view=await original(...args);if(once){once=false;entered();await barrier;}return view;});
 const pending=get('/journal/'+entry.slug+'/');await started;const gone=await content.removeItem(db,actor,entry.id,entry.version);await publish(gone);resume();const response=await pending;expect(response.status).toBe(404);expect(response.headers.has('ETag')).toBe(false);expect(await count()).toBe(0);
});
it('af_prebuild_clock: local midnight expires notice and event output without publishing',async()=>{
 const {one,entry}=await fixture();const dated=await content.updateItem(db,actor,'site',one.version,{theme:'event-page',timezone:'America/New_York',notice:{text:'Until midnight only',until:'2026-11-01'}});await publish(dated);
 const event=await content.updateItem(db,actor,entry.id,entry.version,{event:{start:'2026-11-01T23:59'}});await publish(event);
 const {THEMES}=await import('../src/themes.gen'),themes=await import('../src/themes');const base=THEMES['event-page'];const pkg=JSON.stringify({...base,pages:{...base.pages,entry:base.pages.entry+'<span data-past="{{#entry.event.is_past}}true{{/entry.event.is_past}}{{^entry.event.is_past}}false{{/entry.event.is_past}}"></span>'}});const sum=await artifacts.digest(pkg);
 await themes.install(db,'event-page',actor,async url=>String(url)===themes.CATALOG_URL?Response.json({themes:[{name:'event-page',package:{url:'https://catalog.example/look.json',sha256:sum}}]}):new Response(pkg));
 vi.useFakeTimers({toFake:['Date']});try{
  vi.setSystemTime(new Date('2026-11-02T04:59:30Z'));const before=await get('/journal/'+entry.slug+'/'),body=await before.text();expect(body).toContain('Until midnight only');expect(body).toContain('data-past="false"');expect(await count()).toBe(1);
  vi.setSystemTime(new Date('2026-11-02T05:00:00Z'));const after=await get('/journal/'+entry.slug+'/',{'If-None-Match':before.headers.get('ETag')!}),next=await after.text();expect(after.status).toBe(200);expect(next).not.toContain('Until midnight only');expect(next).toContain('data-past="true"');expect(after.headers.get('ETag')).not.toBe(before.headers.get('ETag'));expect(await count()).toBe(1);
 }finally{vi.useRealTimers();}
});
it('af_prebuild_publication_atomic: a failed post-commit builder cannot undo publication',async()=>{
 const {one}=await fixture();const draft=await content.updateItem(db,actor,'site',one.version,{title:'Committed despite failed build'});await publish(draft);const {preparePublic}=await import('../src/routes');
 const render=vi.spyOn(site,'liveView').mockRejectedValue(Error('build failure'));await expect(preparePublic(e)).rejects.toThrow('build failure');render.mockRestore();expect(await db.prepare("SELECT version FROM live WHERE item_id='site'").first('version')).toBe(draft.version);expect(await(await get()).text()).toContain('Committed despite failed build');
});


it.each(['private','unpublish','expiry'])('af_prebuild_warm_hit_race: %s after current dependency facts cannot deliver the old row',async(change)=>{
 const {one,entry}=await fixture(),path='/journal/'+entry.slug+'/';
 const first=await get(path);expect(first.status).toBe(200);expect(await count()).toBe(1);
 const rendered=vi.spyOn(site,'liveView');
 let calls=0;
 const raced=new Proxy(db,{get(target,key){
  if(key==='prepare')return(sql:string)=>{
   const statement=target.prepare(sql);
   if(sql!==read.FACTS_SQL&&sql!==read.FACTS_STATE_SQL)return statement;
   return new Proxy(statement,{get(t,k){
    if(k==='all')return async(...args:any[])=>{
     const stamp=await (t.all as any)(...args);calls++;
     if(calls===1){
      if(change==='private')await publish(await content.updateItem(db,actor,'site',one.version,{private:true}));
      else if(change==='unpublish')await publish(await content.removeItem(db,actor,entry.id,entry.version));
      else {const until=Number(await db.prepare('SELECT max(valid_until) AS n FROM public_artifacts').first('n'));vi.spyOn(Date,'now').mockReturnValue(until+1000);}
     }
     return stamp;
    };
    const value=Reflect.get(t,k);return typeof value==='function'?value.bind(t):value;
   }});
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const response=await handle(new Request(origin+path,{headers:{'If-None-Match':first.headers.get('ETag')!}}),{...e,DB:raced});
 if(change==='expiry'){expect(rendered).not.toHaveBeenCalled();expect(response.status).toBe(304);expect(response.headers.get('ETag')).toBe(first.headers.get('ETag'));}
 else {expect(response.status).toBe(404);expect(response.headers.has('ETag')).toBe(false);expect(await count()).toBe(0);if(change==='private')expect(await response.text()).toBe(SIGN_IN);}
});


it('af_prebuild_visitor_fill: a first visitor cannot suppress build-ahead of other representations',async()=>{
 const {entry}=await fixture();await get('/journal/'+entry.slug+'/');expect(await count()).toBe(1);
 const paths:string[]=[];
 await artifacts.prepare(db,origin,'test',async(req)=>{paths.push(new URL(req.url).pathname);return new Response('not stored',{status:404});},async()=>['/archive/']);
 expect(paths).toEqual(['/','/index.md','/archive/','/archive/index.md','/llms.txt']);
});

it('af_pipe_table_access: published-only copies, GET/HEAD/304, negotiation and immediate private/removal gate',async()=>{
 const {one,entry}=await fixture();
 const table=await content.updateItem(db,actor,entry.id,entry.version,{body:'| Public | Value |\n| :-- | --: |\n| visible\\|cell | **12** |'});await publish(table);
 const stream=(one.data.streams as {id:string;path:string}[])[0],path='/'+(stream.path||stream.id)+'/'+table.slug+'/';
 const html=await get(path);expect(html.status).toBe(200);expect(await html.text()).toContain('<th scope="col" align="left">Public</th>');
 const direct=await get(path+'index.md'),body=await direct.text(),tag=direct.headers.get('ETag')!;expect(body).toContain('| :--- | ---: |');expect(body).toContain('visible\\|cell');
 const negotiated=await get(path,{Accept:'text/markdown'});expect(await negotiated.text()).toBe(body);expect(negotiated.headers.get('ETag')).toBe(tag);
 for(const method of ['GET','HEAD']){const r=await get(path+'index.md',{'If-None-Match':tag},method);expect(r.status).toBe(304);expect(await r.text()).toBe('');}
 class Browser{jar=new Map<string,string>();async at(path:string,init:RequestInit={}){const r=await handle(new Request(origin+path,{...init,headers:{...(init.headers as Record<string,string>),Cookie:[...this.jar].map(([k,v])=>`${k}=${v}`).join('; ')}}),e);for(const h of r.headers.getSetCookie()){const m=/^([^=;]+)=([^;]*)/.exec(h);if(m)this.jar.set(m[1],m[2]);}return r;}post(path:string,body:any={}){return this.at(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}async options(path:string,body:any={}){return(await(await this.post(path,body)).json() as any).options;}}
 const own=new Browser(),key=await SoftKey.make();expect((await own.post('/setup/verify',await key.create(await own.options('/setup/options',{code:e.SETUP_CODE,name:'owner'}),origin))).status).toBe(200);
 const ownerCopy=await own.at(path+'index.md');expect(await ownerCopy.text()).toBe(body);expect(ownerCopy.headers.get('Cache-Control')).toContain('no-store');expect(ownerCopy.headers.has('ETag')).toBe(false);expect(body).not.toContain('Review');
 const pending=await content.updateItem(db,actor,table.id,table.version,{body:'| SECRET_PENDING | H |\n| - | - |'});expect(await(await get(path+'index.md')).text()).toBe(body);
 for(const headers of ([{Cookie:'__Host-sk_owner=invalid'},{Cookie:'__Host-sk_reader=invalid'},{Authorization:'Bearer invalid'}] as Record<string,string>[])){
  const response=await get(path+'index.md',headers);expect(response.headers.get('Cache-Control')).toContain('no-store');expect(response.headers.has('ETag')).toBe(false);expect(await response.text()).not.toContain('SECRET_PENDING');
 }
 await content.removeItem(db,actor,table.id,pending.version);await publish(await content.getItem(db,table.id));
 const removed=await get(path+'index.md',{'If-None-Match':tag});expect(removed.status).toBe(404);expect(removed.headers.has('ETag')).toBe(false);
 const privateSite=await content.updateItem(db,actor,'site',one.version,{private:true});await publish(privateSite);
 for(const method of ['GET','HEAD']){const r=await get(path+'index.md',{'If-None-Match':tag},method);expect(r.status).toBe(404);expect(await r.text()).toBe(method==='GET'?SIGN_IN:'');}
});
it('af_time_storage_cap: static copies survive hours; expiry never churns a conditional tag',async()=>{
 await fixture();const start=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(start),first=await get(),tag=first.headers.get('ETag')!,body=await first.text();
 const until=Number(await db.prepare('SELECT max(valid_until) AS n FROM public_artifacts').first('n'));expect(until).toBe(start+86400000);
 const load=vi.spyOn(site,'liveView');clock.mockReturnValue(start+7200000);const warm=await get();expect(warm.status).toBe(200);expect(await warm.text()).toBe(body);expect(warm.headers.get('ETag')).toBe(tag);expect(load).not.toHaveBeenCalled();
 clock.mockReturnValue(until+1);const hit=await get('/',{'If-None-Match':tag});expect(hit.status).toBe(304);expect(hit.headers.get('ETag')).toBe(tag);expect(load).not.toHaveBeenCalled();
});

it('af_thin_hit_budget: one facts decode, atomic row proof and no SNAPSHOT on HIT/MISS',async()=>{
 await fixture();const first=await get(),body=await first.text(),tag=first.headers.get('ETag')!;
 const sql=vi.spyOn(db,'prepare'),load=vi.spyOn(site,'liveView'),facts=vi.spyOn(read,'facts'),snap=vi.spyOn(artifacts,'snapshot');
 for(const method of ['GET','HEAD']){
  sql.mockClear();load.mockClear();facts.mockClear();const r=await get('/',{},method);expect(r.status).toBe(200);expect(await r.text()).toBe(method==='HEAD'?'':body);
  expect(sql.mock.calls).toHaveLength(3);expect(sql.mock.calls.filter(([q])=>q===artifacts.lookupSQL())).toHaveLength(1);expect(facts).toHaveBeenCalledTimes(1);expect(load).not.toHaveBeenCalled();expect(snap).not.toHaveBeenCalled();
 }
 sql.mockClear();const conditional=await get('/',{'If-None-Match':tag});expect(conditional.status).toBe(304);expect(sql.mock.calls).toHaveLength(3);expect(sql.mock.calls.some(([q])=>q===artifacts.lookupSQL())).toBe(false);
 sql.mockRestore();await db.prepare('DELETE FROM public_artifacts').run();const queries=vi.spyOn(db,'prepare');load.mockClear();facts.mockClear();
 const miss=await get();expect(await miss.text()).toBe(body);expect(load).toHaveBeenCalledTimes(1);expect(facts).toHaveBeenCalledTimes(2);expect(snap).not.toHaveBeenCalled();
 const all=queries.mock.calls.map(([q])=>q),writes=all.filter(q=>q===artifacts.admitSQL()||/^\s*(INSERT|DELETE|UPDATE)/i.test(q));expect(all.length-writes.length).toBeLessThanOrEqual(6);expect(writes.filter(q=>!q.startsWith('INSERT INTO agent_traffic_daily'))).toHaveLength(2);expect(all.length).toBeLessThanOrEqual(9);
});
it('af_thin_hit_old_runtime: atomic lookup withholds stale generation before purge without a revision bump',async()=>{
 await fixture();const first=await get(),tag=first.headers.get('ETag'),old=await db.prepare('SELECT revision,generation FROM public_artifact_state').first<any>();
 await db.prepare("UPDATE live SET data=json_set(data,'$.title','Old runtime publication') WHERE item_id='site'").run();
 const f=await read.facts(db,true),{RELEASE}=await import('../src/home'),g=await artifacts.generation(f,RELEASE,origin),stored=await db.prepare('SELECT key FROM public_artifacts LIMIT 1').first<any>();
 const refused=await db.prepare(artifacts.lookupSQL()).bind(JSON.stringify(f.raw),g,stored.key,g).first<any>();expect(refused.facts_ok).toBe(1);expect(refused.ok).toBe(0);expect(refused.key).toBeNull();expect(refused.body).toBeNull();
 const live=await handle(new Request(origin+'/'),{...e,PUBLIC_ARTIFACTS:''}),liveBody=await live.text();
 const sql=vi.spyOn(db,'prepare'),snap=vi.spyOn(artifacts,'snapshot');const next=await get(),nextBody=await next.text();expect(nextBody).toContain('Old runtime publication');expect(next.headers.get('ETag')).not.toBe(tag);expect(nextBody).toBe(liveBody);expect(next.headers.get('ETag')).toBe(live.headers.get('ETag'));
 const calls=sql.mock.calls.map(([q])=>q);expect(calls).toContain('DELETE FROM public_artifacts');expect(calls.filter(q=>q===artifacts.lookupSQL())).toHaveLength(1);expect(calls.indexOf(artifacts.lookupSQL())).toBeLessThan(calls.indexOf('DELETE FROM public_artifacts'));expect(snap).not.toHaveBeenCalled();sql.mockRestore();
 expect((await db.prepare('SELECT generation FROM public_artifact_state').first<any>())!.generation).not.toBe(old.generation);
});
it.each(['private','unpublish','theme','title'])('af_thin_hit_races: old-runtime %s between facts and row SELECT fails the complete atomic proof',async(change)=>{
 const {one,entry}=await fixture(),path='/journal/'+entry.slug+'/';await get(path);const original=read.facts;let once=true;
 vi.spyOn(read,'facts').mockImplementation(async(...args:Parameters<typeof read.facts>)=>{const f=await original(...args);if(once){once=false;
  if(change==='private'){await db.prepare("INSERT INTO site_fields(version,key,value,approved)VALUES(?,'private','true',1) ON CONFLICT(version,key) DO UPDATE SET value='true',approved=1").bind(one.version).run();await db.prepare('INSERT OR IGNORE INTO private_approvals(version)VALUES(?)').bind(one.version).run();}
  else if(change==='unpublish')await db.prepare('DELETE FROM live WHERE item_id=?').bind(entry.id).run();
  else await db.prepare("UPDATE live SET data=json_set(data,?,?) WHERE item_id='site'").bind(change==='theme'?'$.theme':'$.title',change==='theme'?'local-business':'New approved title').run();
 }return f;});
 const r=await get(path);if(change==='private'||change==='unpublish'){expect(r.status).toBe(404);expect(r.headers.has('ETag')).toBe(false);if(change==='private')expect(await r.text()).toBe(SIGN_IN);}
 else{expect(r.status).toBe(200);if(change==='title')expect(await r.text()).toContain('New approved title');}
});
it('af_thin_hit_races: equal counts with duplicate/missing raw tuples cannot authorize a row',async()=>{
 await fixture();await get();const f=await read.facts(db,true),row=await db.prepare('SELECT key,generation FROM public_artifacts LIMIT 1').first<any>();
 const raw=f.raw!.map(r=>[...r]);expect(raw.length).toBeGreaterThan(2);raw[0]=raw[1];
 const result=await db.prepare(artifacts.lookupSQL()).bind(JSON.stringify(raw),row.generation,row.key,row.generation).first<any>();expect(result.ok).toBe(0);expect(result.body).toBeNull();
});
it('af_thin_miss_admission: generation setup cannot release its own build lease',async()=>{
 await fixture();let entered!:()=>void,resume!:()=>void;const started=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>resume=r);let first=true;
 const job=artifacts.prepare(db,origin,'test',async()=>{if(first){first=false;entered();await barrier;}return new Response('not stored',{status:404});},async()=>[]);await started;
 const token=await db.prepare('SELECT preparing FROM public_artifact_state WHERE id=1').first<string>('preparing');expect(token).toBeTruthy();let competing=false;
 await artifacts.prepare(db,origin,'test',async()=>{competing=true;return new Response('not stored',{status:404});},async()=>[]);expect(competing).toBe(false);expect(await db.prepare('SELECT preparing FROM public_artifact_state WHERE id=1').first('preparing')).toBe(token);
 resume();await job;expect(await db.prepare('SELECT preparing FROM public_artifact_state WHERE id=1').first('preparing')).toBe('');
});
it('af_thin_miss_admission: old-runtime change after live proof cannot admit a stale body',async()=>{
 await fixture();const original=read.facts;let calls=0;
 vi.spyOn(read,'facts').mockImplementation(async(...args:Parameters<typeof read.facts>)=>{const f=await original(...args);if(++calls===2)await db.prepare("UPDATE live SET data=json_set(data,'$.title','Admission race title') WHERE item_id='site'").run();return f;});
 const r=await get();expect(r.status).toBe(200);expect(await r.text()).toContain('Admission race title');expect(await count()).toBe(0);
});
it('af_thin_hit_old_runtime: shared G2 encoding excludes mutable observed state counters',async()=>{
 const {default:cases}=await import('../../spec/fixtures/public-artifacts-thin.json');
 for(const c of cases){const f={rows:c.rows,generation:'not-authority',revision:99} as unknown as read.Facts;expect(await artifacts.generation(f,'fixture','https://example.com'),c.name).toBe(c.sha256);}
});
it('af_thin_hit_budget: indexed row proof does not scan unused image libraries',async()=>{
 await fixture();await get();const f=await read.facts(db,true),row=await db.prepare('SELECT key,generation FROM public_artifacts LIMIT 1').first<any>(),args=[JSON.stringify(f.raw),row.generation,row.key,row.generation];
 const before=await db.prepare(artifacts.lookupSQL()).bind(...args).all();
 await db.prepare("WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<500) INSERT INTO media(name,type,size,chunks,created_at) SELECT printf('%032x',n)||'.png','image/png',1,0,'2026-10-18' FROM x").run();
 const after=await db.prepare(artifacts.lookupSQL()).bind(...args).all();expect(after.results).toEqual(before.results);expect(after.meta.rows_read).toBe(before.meta.rows_read);expect(after.meta.rows_written).toBe(0);
 const plan=await db.prepare('EXPLAIN QUERY PLAN '+artifacts.lookupSQL()).bind(...args).all<{detail:string}>();expect(plan.results.some(r=>/SEARCH a USING INDEX.*key=/.test(r.detail))).toBe(true);
 console.log(JSON.stringify({case:'af_thin_hit_budget',rows_read:after.meta.rows_read,unused_images:500,plan:plan.results.map(r=>r.detail)}));
});
it('af_thin_hit_isolation: unavailable artifact state falls back live and never widens private access',async()=>{
 const {one}=await fixture();const first=await(await get()).text();await db.prepare('ALTER TABLE public_artifact_state RENAME TO unavailable_artifact_state').run();
 try{
  const lookup=artifacts.lookupSQL(),sql=vi.spyOn(db,'prepare');const live=await get();expect(live.status).toBe(200);expect(await live.text()).toBe(first);expect(sql.mock.calls.filter(([query])=>query===lookup)).toHaveLength(1);
  await db.prepare("INSERT INTO site_fields(version,key,value,approved)VALUES(?,'private','true',1) ON CONFLICT(version,key) DO UPDATE SET value='true',approved=1").bind(one.version).run();await db.prepare('INSERT OR IGNORE INTO private_approvals(version)VALUES(?)').bind(one.version).run();
  const denied=await get();expect(denied.status).toBe(404);expect(await denied.text()).toBe(SIGN_IN);expect(denied.headers.has('ETag')).toBe(false);expect(sql.mock.calls.filter(([query])=>query===lookup)).toHaveLength(1);
 }finally{await db.prepare('ALTER TABLE unavailable_artifact_state RENAME TO public_artifact_state').run();}
});
it('af_thin_hit_time: a boundary after the live render cannot return the expired fill',async()=>{
 const {one}=await fixture();await publish(await content.updateItem(db,actor,'site',one.version,{theme:'event-page',timezone:'UTC',notice:{text:'Only before midnight',until:'2026-11-01'}}));
 vi.useFakeTimers({toFake:['Date']});try{
  vi.setSystemTime(new Date('2026-11-01T23:59:30Z'));const request=new Request(origin+'/'),{RELEASE}=await import('../src/home');let oldTag='';
  const response=await artifacts.respond(db,request,origin,RELEASE,async()=>{const r=await handle(request,{...e,PUBLIC_ARTIFACTS:''});expect(await r.clone().text()).toContain('Only before midnight');oldTag=r.headers.get('ETag')!;vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));return r;},undefined,()=>handle(request,{...e,PUBLIC_ARTIFACTS:''}));
  expect(response.status).toBe(200);expect(await response.text()).not.toContain('Only before midnight');expect(response.headers.get('ETag')).not.toBe(oldTag);expect(await count()).toBe(0);
 }finally{vi.useRealTimers();}
});
