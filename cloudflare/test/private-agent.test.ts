// AG-4/5: paired with the server private-agent tests.
import {env} from 'cloudflare:workers';
import {beforeEach,it,expect,vi} from 'vitest';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as read from '../src/read-keys';
import * as agent from '../src/private-agent';
import * as site from '../src/site';
import * as artifacts from '../src/public-artifacts';
import {handle} from '../src/routes';
import {BLANK,SIGN_IN} from '../src/privacy';
import type {Env} from '../src/env';
const e=env as unknown as Env,db=e.DB,origin='https://site.example';
const go=(path:string,headers:Record<string,string>={},method='GET')=>handle(new Request(origin+path,{method,headers}),{...e,PUBLIC_ARTIFACTS:'1',SITE_URL:origin});
const hash=async(s:string)=>btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
beforeEach(async()=>{vi.restoreAllMocks();const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();for(const {name} of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();});
async function fixture(){
 const item=await content.createItem(db,'assistant:test','site',{title:'Private handbook',private:true,streams:[{id:'guide',title:'Guides',dated_addresses:false}],archive:{enabled:true,title:'All pages'}},undefined);
 const entry=await content.createItem(db,'assistant:test','entry',{stream:'guide',title:'Published guide',date:'2026-10-17',body:'Visible private prose.',tags:['report']},undefined);
 await approvals.publishNow(db,[{id:'site',version:item.version},{id:entry.id,version:entry.version}],'',origin);
 await content.updateItem(db,'assistant:test',entry.id,entry.version,{body:'DRAFT SECRET'});
 const key=await read.create(db,'Read key'),second=await read.create(db,'Other key');
 for(const token of ['owner-one','owner-two'])await db.prepare("INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,'2026-10-17','2099-01-01')").bind(await hash(token)).run();
 await db.prepare("INSERT INTO readers(id,name,created_at) VALUES('reader','Reader','2026-10-17')").run();
 await db.prepare("INSERT INTO reader_passkeys(id,reader_id,public_key,created_at) VALUES('credential','reader',x'01','2026-10-17')").run();
 await db.prepare("INSERT INTO reader_sessions(token_hash,reader_id,credential_id,epoch,created_at,expires_at) VALUES(?,'reader','credential',0,'2026-10-17','2099-01-01')").bind(await hash('reader-one')).run();
 return {item,entry,key,second,auth:{Authorization:'Bearer '+key.token},owner:{Cookie:'__Host-sk_owner=owner-one'},reader:{Cookie:'__Host-sk_reader=reader-one'}};
}
async function blank(r:Response,head=false,browser=false){expect(r.status).toBe(404);expect(await r.text()).toBe(head?'':browser?SIGN_IN:BLANK);expect(r.headers.get('Cache-Control')).toBe('private, no-store, no-transform');for(const name of ['ETag','Last-Modified','Link','Vary','Age','Location'])expect(r.headers.has(name)).toBe(false);}
it('ag_private_gate_first and credential precedence: invalid stays exact blank before views',async()=>{
 const f=await fixture();const spy=vi.spyOn(site,'liveView').mockRejectedValue(Error('view before auth'));
 for(const headers of ([{},{Authorization:'Bearer unknown'},{...f.owner,Authorization:'Bearer unknown'},{Cookie:'__Host-sk_owner=expired'},{Authorization:'Bearer psk_unknown'}] as Record<string,string>[]))for(const path of ['/','/index.md','/llms.txt','/guide/published-guide/index.md','/missing/index.md'])for(const method of ['GET','HEAD'])await blank(await go(path,{...headers,Accept:'text/markdown','If-None-Match':'*'},method),method==='HEAD',!Object.hasOwn(headers,'Authorization'));
 expect(spy).not.toHaveBeenCalled();
});
it('ag_bearer_html_published ag_bearer_html_cache: reader bytes, no validators or shared cache',async()=>{
 const f=await fixture();for(const path of ['/','/guide/published-guide/','/archive/?stream=guide&tag=report']){
  const reader=await go(path,f.reader),body=await reader.text();
  for(const method of ['GET','HEAD']){const res=await go(path,{...f.auth,'If-None-Match':'*'},method);expect(res.status).toBe(200);expect(await res.text()).toBe(method==='HEAD'?'':body);expect(res.headers.get('Cache-Control')).toBe('private, no-store, no-transform');for(const h of ['ETag','Last-Modified','Content-Signal'])expect(res.headers.has(h)).toBe(false);}
 }
 for(const path of ['/review','/media/00000000000000000000000000000000.jpg','/sitemap.xml','/guide/feed.xml'])await blank(await go(path,f.auth));
 expect(await db.prepare('SELECT count(*) n FROM public_artifacts').first('n')).toBe(0);
});
it('ag_private_markdown_identity ag_private_map ag_private_conditionals: same published text and principal tags',async()=>{
 const f=await fixture();const tags=new Set<string>();let firstTag='';
 for(const headers of [f.auth,f.owner,f.reader,{Authorization:'Bearer '+f.second.token},{Cookie:'__Host-sk_owner=owner-two'}]){
  const direct=await go('/guide/published-guide/index.md',headers),body=await direct.text(),tag=direct.headers.get('ETag')!;tags.add(tag);
  if(firstTag)expect((await go('/guide/published-guide/index.md',{...headers,'If-None-Match':firstTag})).status).toBe(200);else firstTag=tag;
  expect(body).toContain('Visible private prose');expect(body).not.toContain('DRAFT SECRET');expect(body).not.toContain('/review');expect(direct.headers.get('Cache-Control')).toBe(agent.PRIVATE_LIGHT);expect(tag).toMatch(/^W\/"ag-sha256-[a-f0-9]{64}"$/);
  const negotiated=await go('/guide/published-guide/',{...headers,Accept:'text/markdown'});expect(await negotiated.text()).toBe(body);expect(negotiated.headers.get('ETag')).toBe(tag);expect(negotiated.headers.get('Vary')).toBe('Accept');expect(direct.headers.has('Vary')).toBe(false);
  const head=await go('/guide/published-guide/index.md',headers,'HEAD');expect(await head.text()).toBe('');expect([...head.headers]).toEqual([...direct.headers]);expect(head.headers.get('Content-Length')).toBe(String(new TextEncoder().encode(body).length));
  for(const match of [tag,tag.replace('W/',''),'*']){const conditional=await go('/guide/published-guide/index.md',{...headers,'If-None-Match':match});expect(conditional.status).toBe(304);expect(await conditional.text()).toBe('');expect(conditional.headers.get('Cache-Control')).toBe(agent.PRIVATE_LIGHT);}
  const foreign=await go('/guide/published-guide/index.md',{...headers,'If-None-Match':'W/"sha256-foreign"','If-Modified-Since':'Wed, 01 Jan 2099 00:00:00 GMT'});expect(foreign.status).toBe(200);
  const map=await go('/llms.txt',headers),text=await map.text();expect(text).toContain('/index.md');expect(text).toContain('/archive/index.md');expect(text).toContain('/guide/published-guide/index.md');expect(text).not.toContain('/review');expect(text).not.toContain(f.key.token);expect(map.headers.get('Cache-Control')).toBe(agent.PRIVATE_LIGHT);
 }
 expect(tags.size).toBe(5);expect(await db.prepare('SELECT count(*) n FROM public_artifacts').first('n')).toBe(0);expect(await db.prepare('SELECT count(*) n FROM agent_traffic_daily').first('n')).toBe(0);
});
it('ag_private_revoke_expire_epoch: old tags never authorize; private robots unchanged',async()=>{
 const f=await fixture(),first=await go('/index.md',f.auth),tag=first.headers.get('ETag')!;
 await read.revoke(db,f.key.id);await blank(await go('/index.md',{...f.auth,'If-None-Match':tag}));
 await db.prepare('UPDATE auth_state SET owner_epoch=owner_epoch+1 WHERE id=1').run();await blank(await go('/llms.txt',f.owner),false,true);await blank(await go('/index.md',{Authorization:'Bearer '+f.second.token}));
 await db.prepare('UPDATE readers SET revoked=1').run();await blank(await go('/index.md',f.reader),false,true);
 const robots=await go('/robots.txt',{...f.auth,'If-None-Match':'*'});expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');expect(robots.headers.has('ETag')).toBe(false);
});
it.each(['revoke','unpublish'])('ag_private_delivery_races: stalled render across %s never returns old copy',async(change)=>{
 const f=await fixture(),original=artifacts.snapshot;let calls=0;
 vi.spyOn(artifacts,'snapshot').mockImplementation(async(...args)=>{const stamp=await original(...args);if(++calls===1){if(change==='revoke')await read.revoke(db,f.key.id);else await db.prepare('DELETE FROM live WHERE item_id=?').bind(f.entry.id).run();}return stamp;});
 const res=await go('/guide/published-guide/index.md',f.auth),text=await res.text();expect(res.status).toBe(404);expect(text).not.toContain('Visible private prose');expect(res.headers.has('ETag')).toBe(false);
});

it('ag_private_negotiation and filtered canonical identity refuse only after authorization',async()=>{
 const f=await fixture();
 const a=await go('/archive/index.md?sort=date&tag=report&stream=guide',f.auth),b=await go('/archive/?stream=guide&tag=report',{...f.auth,Accept:'text/markdown'});
 expect(a.status).toBe(200);expect(await a.text()).toBe(await b.text());expect(a.headers.get('ETag')).toBe(b.headers.get('ETag'));
 for(const path of ['/archive/?invalid=value','/archive/index.md?tag=report&tag=other']){const r=await go(path,{...f.auth,Accept:'text/markdown'});expect(r.status).toBe(400);expect(r.headers.has('ETag')).toBe(false);await blank(await go(path,{Authorization:'Bearer unknown',Accept:'text/markdown'}));}
 const refusal=await go('/',{...f.auth,Accept:'text/html;q=0,text/markdown;q=0'});expect(refusal.status).toBe(406);expect(refusal.headers.get('Vary')).toBe('Accept');expect(refusal.headers.has('ETag')).toBe(false);
 expect((await go('/index.md',{...f.auth,Accept:'application/json'})).status).toBe(200);
 await db.prepare("UPDATE agent_read_keys SET expires_at='2000-01-01' WHERE id=?").bind(f.key.id).run();await blank(await go('/index.md',{...f.auth,'If-None-Match':'*'}));
});
it('ag_private_visible_validator_input: hidden published rows do not alter private copies or tags',async()=>{
 const f=await fixture();await db.prepare("UPDATE live SET published_at='2026-10-17T10:00:00.000Z'").run();
 const paths=['/index.md','/llms.txt'],before=await Promise.all(paths.map(async path=>{const r=await go(path,f.auth);expect(r.status).toBe(200);return {body:await r.text(),tag:r.headers.get('ETag')!};}));
 for(const [kind,data] of [['card',{name:'HIDDEN CARD',description:'Hidden private description',visibility:'private'}],['entry',{stream:'guide',title:'HIDDEN STATUS',date:'2026-10-17',status:'draft',body:'Hidden status prose'}]] as const){
  const item=await content.createItem(db,'assistant:test',kind,data,undefined);await approvals.publishNow(db,[{id:item.id,version:item.version}],'',origin);await db.prepare("UPDATE live SET published_at='2031-01-01T00:00:00.000Z' WHERE item_id=?").bind(item.id).run();
 }
 for(let i=0;i<paths.length;i++){const r=await go(paths[i],f.auth);expect(await r.text()).toBe(before[i].body);expect(r.headers.get('ETag')).toBe(before[i].tag);expect((await go(paths[i],{...f.auth,'If-None-Match':before[i].tag})).status).toBe(304);}
});
