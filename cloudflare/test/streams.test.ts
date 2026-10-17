import {env} from 'cloudflare:workers';
import {beforeEach,expect,it} from 'vitest';
import type {Env} from '../src/env';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as history from '../src/history';
import * as site from '../src/site';
import * as theme from '../src/theme';
import * as owner from '../src/owner';
import {handle} from '../src/routes';
import {SIGN_IN as BLANK} from '../src/privacy';
import {SoftKey} from './softkey';
import * as changes from '../src/changes';
import * as importer from '../src/importer';
const e=env as unknown as Env, db=e.DB, actor='assistant:test', origin='https://site.example';
const streams=(n=9)=>Array.from({length:n},(_,i)=>({id:`part-${i}`,title:`Part ${i}`,sort:i===0?'title':'date'}));
async function publish(ids:string[]){const a=await approvals.request(db,actor,ids,'');await approvals.decide(db,a.id,Object.fromEntries(ids.map(id=>[id,{decision:'approve' as const}])),'',origin);}
beforeEach(async()=>{
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name} of tables.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state (id) VALUES (1)').run();
});
it('ST-1 bounds 64 streams and retains logical settings through approval/history/rollback/revert without poisoning legacy JSON',async()=>{
 expect(content.validate('site',{streams:streams(64)}).streams).toHaveLength(64);
 expect(()=>content.validate('site',{streams:streams(65)})).toThrow();
 const one=await content.createItem(db,actor,'site',{streams:streams(),sections:['part-8','entries'],archive:{enabled:true,title:'All reports'}},undefined);
 expect(one.data.streams).toHaveLength(9);expect((await content.siteData(db,true)).archive).toMatchObject({enabled:false});
 await publish(['site']);expect((await content.siteData(db,true)).streams).toHaveLength(9);
 const version=one.version;
 await expect(importer.importFile(db,JSON.stringify({porchsite_import:1,items:[{kind:'entry',data:{title:'Must not save',date:'2026-10-17'}},{kind:'site',data:{streams:[{id:'one',title:'One',path:'shared'},{id:'two',title:'Two',path:'shared'}],sections:['entries']}}]}))).rejects.toMatchObject({code:'invalid'});
 expect((await content.getItem(db,'site')).version).toBe(version);expect(await db.prepare('SELECT count(*) n FROM items').first('n')).toBe(1);
 const p=(await history.publishes(db))[0].id;
 const two=await content.updateItem(db,actor,'site',1,{streams:streams(2),sections:['entries'],archive:{enabled:false}});await publish(['site']);
 const back=await content.rollback(db,actor,'site',1,two.version);expect(back.data.streams).toHaveLength(9);
 await history.revert(db,p,'',origin);expect((await content.siteData(db,true)).streams).toHaveLength(9);
 const versions=await content.history(db,'site');expect(versions.find(v=>v.version===1)!.data.streams).toHaveLength(9);
 const rows=(await db.prepare("SELECT data FROM items WHERE id='site' UNION ALL SELECT data FROM revisions WHERE item_id='site' UNION ALL SELECT data FROM live WHERE item_id='site'").all<{data:string}>()).results;
 for(const row of rows){const data=JSON.parse(row.data);expect(data.streams.length).toBeLessThanOrEqual(8);expect(data.sections.length).toBeLessThanOrEqual(12);expect(data).not.toHaveProperty('archive');expect(data.streams.every((s:any)=>!('sort' in s))).toBe(true);}
});
it('ST-1 unseen old approval and edits never inherit the extension; stale writes leave it unchanged',async()=>{
 await content.createItem(db,actor,'site',{streams:streams(),archive:{enabled:true}},undefined);
 await db.prepare("INSERT INTO live (item_id,kind,version,data,published_at) SELECT id,kind,version,data,updated_at FROM items WHERE id='site'").run();
 expect((await content.siteData(db,true)).streams).toHaveLength(8);expect((await content.siteData(db,true)).archive).toMatchObject({enabled:false});
 await db.prepare("UPDATE items SET version=2 WHERE id='site'").run();
 expect((await content.getItem(db,'site')).data.streams).toHaveLength(8);
 await expect(content.updateItem(db,actor,'site',1,{title:'stale'})).rejects.toMatchObject({code:'version_conflict'});
 expect(await db.prepare('SELECT count(*) n FROM site_stream_settings').first('n')).toBe(1);
});
it('ST-1 retries/concurrent writes preserve one settings record per version; import and approval text retain the ninth stream and sort',async()=>{
 const input={streams:streams(),sections:['part-8','entries'],archive:{enabled:true,title:'All reports'}};
 const first=await content.createItem(db,actor,'site',input,'streams-once');
 expect((await content.createItem(db,actor,'site',input,'streams-once')).version).toBe(1);
 expect(await db.prepare('SELECT count(*) n FROM site_stream_settings').first('n')).toBe(1);
 const results=await Promise.allSettled([content.updateItem(db,actor,'site',1,{title:'First'}),content.updateItem(db,actor,'site',1,{title:'Second'})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.prepare('SELECT count(*) n FROM site_stream_settings').first('n')).toBe(2);
 const text=String(changes.fieldRows('site',first.data));expect(text).toContain('Part 8');expect(text).toContain('By title');expect(text).toContain('On · All reports');
 const changed=String(changes.whatChanged('site',{...first.data,streams:streams().map(s=>({...s,sort:'date'}))},first.data));expect(changed).toContain('Newest first');expect(changed).toContain('By title');
 await importer.importFile(db,JSON.stringify({porchsite_import:1,items:[{kind:'site',data:{title:'Imported report site'}}]}));
 const item=await content.getItem(db,'site');expect(item.data.streams).toHaveLength(9);expect(item.data.sections).toEqual(['part-8','entries']);
 await publish(['site']);expect((await content.siteData(db,true)).streams).toHaveLength(9);
});
it('ST-2 omits drafts pending unpublished private cards and full bodies; filters intersect and unknown valid filters are empty; escapes labels and summaries',async()=>{
 await content.createItem(db,actor,'site',{title:'<Site>',theme:'personal-homepage',streams:[{id:'one',title:'<One>'},{id:'two',title:'Two'}],archive:{enabled:true,title:'<Archive>'}},undefined);
 const a=await content.createItem(db,actor,'entry',{stream:'one',title:'<Visible>',summary:'<Summary>',date:'2026-10-17',body:'FULL_BODY_NOT_LISTED',tags:['report','report']},undefined);
 const b=await content.createItem(db,actor,'entry',{stream:'two',title:'Second',date:'2026-10-16',tags:['other']},undefined);
 await content.createItem(db,actor,'entry',{title:'SECRET_DRAFT',date:'2026-10-17',status:'draft',tags:['secret-draft']},undefined);
 const pending=await content.createItem(db,actor,'entry',{title:'SECRET_PENDING',date:'2026-10-17',tags:['secret-pending']},undefined);
 const card=await content.createItem(db,actor,'card',{name:'SECRET_CARD',description:'Hidden card description',visibility:'private'},undefined);
 await publish(['site',a.id,b.id,card.id]);
 await approvals.request(db,actor,[pending.id],'Pending report');
 const unpublished=await content.createItem(db,actor,'entry',{title:'SECRET_UNPUBLISHED',date:'2026-10-17',tags:['secret-unpublished']},undefined);await publish([unpublished.id]);await content.removeItem(db,actor,unpublished.id,1);await publish([unpublished.id]);
 const get=(path:string)=>handle(new Request(origin+path),e);
 const r=await get('/archive/');expect(r.status).toBe(200);const body=await r.text();
 for(const secret of ['SECRET_DRAFT','SECRET_PENDING','SECRET_UNPUBLISHED','SECRET_CARD','secret-draft','secret-pending','secret-unpublished','FULL_BODY_NOT_LISTED'])expect(body).not.toContain(secret);
 expect(body).toContain('&#60;Archive&#62;');expect(body).toContain('&#60;Summary&#62;');expect(body).not.toContain('<Visible>');expect(body).toContain('report (1)');
 expect(r.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
 for(const query of ['stream=missing','tag=missing','stream=two&tag=report']){const text=await(await get('/archive/?'+query)).text();expect(text).toContain('No entries match.');expect(text).not.toContain('&#60;Visible&#62;');}
 for(const query of ['sort=bogus','tag=%3Cscript%3E','unknown=1','sort=date&sort=stream','stream=bad/path'])expect((await get('/archive/?'+query)).status).toBe(400);
 const redir=await get('/archive?tag=report');expect(redir.status).toBe(301);expect(redir.headers.get('Location')).toBe('/archive/?tag=report');
 const sitemap=await(await get('/sitemap.xml')).text();expect(sitemap).toContain('/archive/</loc>');expect(sitemap).not.toContain('SECRET_');
 await expect(content.updateItem(db,actor,'site',1,{streams:[{id:'archive',title:'Conflict'}]})).rejects.toMatchObject({code:'invalid'});
 await content.updateItem(db,actor,'site',1,{theme:'built-in'});await publish(['site']);
 const fallback=await(await get('/archive/')).text();expect(fallback).toContain('href="/archive/?stream=one"');expect((await get('/archive/?stream=one')).status).toBe(200);
});
it('ST-3 title order is scalar/stable on home/archive/tag/search; latest and feed stay chronological',async()=>{
 const s=content.validate('site',{streams:[{id:'one',title:'One',sort:'title',layout:'feature'}]});
 const v=site.view(s,[['z','Zulu','2026-10-17'],['a','Alpha','2026-10-16'],['b','Alpha','2026-10-15'],['c','\u{10000}','2026-10-14'],['d','\ue000','2026-10-13']].map(([id,title,date])=>({id,kind:'entry',slug:id,data:content.validate('entry',{title,date,stream:'one',tags:['tag']})})));
 const home=theme.homeView(v,'test',origin).sections[0];expect(home.items.map((e:any)=>e.id)).toEqual(['a','b','z']);expect(home.latest[0].id).toBe('z');
 expect(theme.archiveView(v,'one','test',origin)!.entries.map((e:any)=>e.id)).toEqual(['a','b','z','d','c']);
 expect(theme.archiveView(v,'one','test',origin,'tag')!.entries[0].id).toBe('a');
 const index=theme.searchIndex(v,'one')!;expect((await index.json() as any)[0].t).toBe('Alpha');
 const feed=await theme.feed(v,'one',origin)!.text();expect(feed.indexOf('Zulu')).toBeLessThan(feed.indexOf('Alpha'));
});
it('ST-2 private archive gates before malformed queries or redirects; owner and reader responses are no-store (GET/HEAD)',async()=>{
 class Browser{jar=new Map<string,string>();async at(path:string,init:RequestInit={}){const r=await handle(new Request(origin+path,{...init,headers:{...(init.headers as Record<string,string>),Cookie:[...this.jar].map(([k,v])=>`${k}=${v}`).join('; ')}}),e);for(const h of r.headers.getSetCookie()){const m=/^([^=;]+)=([^;]*)/.exec(h);if(m)this.jar.set(m[1],m[2]);}return r;}post(path:string,body:any={}){return this.at(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}async options(path:string,body:any={}){return(await(await this.post(path,body)).json() as any).options;}}
 const own=new Browser(),key=await SoftKey.make();await own.post('/setup/verify',await key.create(await own.options('/setup/options',{code:e.SETUP_CODE,name:'owner'}),origin));
 await content.createItem(db,actor,'site',{private:true,archive:{enabled:true}},undefined);await publish(['site']);
 const read=new Browser(),rk=await SoftKey.make(),invite=await owner.createReaderInvite(db,'Reader');await read.post(`/invite/${invite.token}/verify`,await rk.create(await read.options(`/invite/${invite.token}/options`),origin));
 for(const path of ['/archive/','/archive','/archive/?sort=bogus','/archive/?tag=%3Cscript%3E','/archive/?stream=not-a-stream','/archive/?unknown=1'])for(const method of ['GET','HEAD']){
  const r=await new Browser().at(path,{method,headers:{'If-None-Match':'"old"'}});expect(r.status).toBe(404);expect(r.headers.get('Location')).toBeNull();expect(r.headers.get('Cache-Control')).toBe('private, no-store, no-transform');expect(await r.text()).toBe(method==='GET'?BLANK:'');
  for(const browser of [own,read]){const r=await browser.at(path,{method});expect(r.headers.get('Cache-Control')).toBe('private, no-store, no-transform');expect(r.status).toBe(path==='/archive'?301:path.includes('bogus')||path.includes('script')||path.includes('unknown')?400:200);}
 }
 for(const browser of [own,read])expect(await(await browser.at('/archive/?stream=missing')).text()).toContain(`<link rel="canonical" href="${origin}/archive/">`);
 for(const browser of [own,read,new Browser()])for(const path of ['/archive/?sort=bogus','/archive/index.md?tag=report','/archive/index.md?sort=bogus'])for(const method of ['GET','HEAD']){
  const r=await browser.at(path,{method,headers:{Accept:'text/markdown','If-None-Match':'*'}});expect(r.status).toBe(404);expect(await r.text()).toBe(method==='GET'?BLANK:'');
  expect(r.headers.get('Content-Type')).toBe('text/html; charset=utf-8');expect(r.headers.get('Cache-Control')).toBe('private, no-store, no-transform');
  for(const h of ['ETag','Last-Modified','Link','Vary','Content-Signal','Location'])expect(r.headers.get(h)).toBeNull();
 }
});

it('af_combined_archive copies preserve filters, canonical validators and map visibility',async()=>{
 await content.createItem(db,actor,'site',{title:'Archive site',theme:'personal-homepage',ai_training_disabled:true,streams:streams(),sections:['entries'],archive:{enabled:true,title:'All reports'}},undefined);
 const one=await content.createItem(db,actor,'entry',{stream:'part-0',title:'First report',date:'2026-10-17',summary:'First summary',tags:['report']},undefined);
 const nine=await content.createItem(db,actor,'entry',{stream:'part-8',title:'Ninth report',date:'2026-10-16',summary:'Ninth summary',tags:['other']},undefined);
 await content.createItem(db,actor,'entry',{stream:'part-8',title:'SECRET_DRAFT',date:'2026-10-18'},undefined);
 await publish(['site',one.id,nine.id]);
 const live=await content.siteData(db,true);expect(live.streams).toHaveLength(9);expect(live.ai_training_disabled).toBe(true);expect(await db.prepare("SELECT data FROM live WHERE item_id='site'").first('data')).not.toContain('ai_training_disabled');
 const get=(path:string,headers:Record<string,string>={},method='GET')=>handle(new Request(origin+path,{method,headers}),e);
 const query='?tag=report&stream=part-0&sort=stream',canonical='?sort=stream&stream=part-0&tag=report';
 const html=await get('/archive/'+query);expect(html.status).toBe(200);expect(html.headers.get('Link')).toContain('/archive/index.md'+canonical);
 const htmlBody=await html.text();expect(htmlBody).toContain('/archive/index.md?sort=stream&amp;stream=part-0&amp;tag=report');
 expect(htmlBody).toContain(`<link rel="canonical" href="${origin}/archive/?sort=stream&amp;stream=part-0&amp;tag=report">`);
 expect(await(await get('/archive/?sort=date&stream=part-0&tag=report')).text()).toContain(`<link rel="canonical" href="${origin}/archive/?stream=part-0&amp;tag=report">`);
 const md=await get('/archive/'+query,{Accept:'text/markdown'}),body=await md.text();expect(body).toContain('<'+origin+'/archive/'+canonical+'>');expect(body).toContain('First report');expect(body).not.toContain('Ninth report');expect(body).not.toContain('SECRET_DRAFT');
 const direct=await get('/archive/index.md'+canonical);expect(await direct.text()).toBe(body);expect(direct.headers.get('ETag')).toBe(md.headers.get('ETag'));
 const tag=md.headers.get('ETag')!;expect(tag).toBeTruthy();expect(html.headers.get('ETag')).not.toBe(tag);
 for(const path of ['/archive/'+query,'/archive/index.md'+canonical])for(const method of ['GET','HEAD']){const r=await get(path,{Accept:'text/markdown','If-None-Match':tag},method);expect(r.status).toBe(304);expect(await r.text()).toBe('');}
 const other=await get('/archive/index.md?stream=part-8');expect(await other.text()).toContain('Ninth report');expect(other.headers.get('ETag')).not.toBe(tag);
 for(const headers of [{Cookie:'__Host-sk_owner=expired'},{Cookie:'__Host-sk_reader=revoked'},{Authorization:'Bearer invalid'}] as Record<string,string>[]){const r=await get('/archive/index.md'+canonical,headers);expect(await r.text()).toBe(body);expect(r.headers.get('ETag')).toBeNull();expect(r.headers.get('Cache-Control')).toBe('private, no-store, no-transform');}
 for(const query of ['?unknown=1','?sort=date&sort=stream','?tag=%3Cscript%3E']){const r=await get('/archive/index.md'+query);expect(r.status).toBe(400);expect(r.headers.get('ETag')).toBeNull();}
 const map=await(await get('/llms.txt')).text();expect(map.indexOf('/index.md')).toBeLessThan(map.indexOf('/archive/index.md'));expect(map).toContain('/archive/index.md');expect(map).not.toContain('SECRET_DRAFT');
 await content.updateItem(db,actor,'site',1,{archive:{enabled:false}});await publish(['site']);
 const missing=await get('/archive/index.md'+canonical,{'If-None-Match':tag});expect(missing.status).toBe(404);expect(missing.headers.get('ETag')).toBeNull();expect(await(await get('/llms.txt')).text()).not.toContain('/archive/index.md');
});
