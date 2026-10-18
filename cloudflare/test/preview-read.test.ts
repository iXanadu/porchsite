import {env} from 'cloudflare:workers';
import {it,expect,beforeEach,afterEach,vi} from 'vitest';
import * as preview from '../src/preview-read';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import {markdownDocument} from '../src/agent-markdown';
import {TOOL_DEFINITIONS} from '../src/mcp';
import {ALLOWED} from '../src/read-keys';
const db=(env as unknown as Env).DB,origin='https://site.example',actor='assistant:test';
const authority={principal:'writer:test',epoch:0};
const context={origin,authorize:async()=>authority};
beforeEach(async()=>{
 vi.restoreAllMocks();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
 const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name}of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();
});
afterEach(()=>vi.useRealTimers());
async function publish(item:content.Item){await approvals.publishNow(db,[{id:item.id,version:item.version}],'',origin);}
async function fixture(theme='personal-homepage'){
 const site=await content.createItem(db,actor,'site',{title:'Inspection site',theme,streams:[{id:'journal',title:'Notes'}],archive:{enabled:true,title:'All entries'}},undefined);await publish(site);
 const entry=await content.createItem(db,actor,'entry',{title:'Selected title',body:'Approved baseline.',date:'2026-10-18'},undefined);await publish(entry);
 const pending=await content.updateItem(db,actor,entry.id,entry.version,{body:'Pending selected text.'});
 const approval=await approvals.request(db,actor,[pending.id],'Inspect');
 await content.createItem(db,actor,'entry',{title:'UNRELATED_DRAFT',body:'Unrelated staged text.',date:'2026-10-18'},undefined);
 return {site,entry,pending,approval,path:'/journal/'+entry.slug+'/'};
}
it('preview_catalog: writer only, read-only annotation and strict schema',()=>{
 expect(TOOL_DEFINITIONS.preview_read.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});expect(ALLOWED.has('preview_read')).toBe(false);
 expect(TOOL_DEFINITIONS.preview_read.inputSchema.safeParse({approval_id:'abcdefgh',unknown:true}).success).toBe(false);
});
it('preview_overlay: selected pending revision and approved baseline only',async()=>{
 const f=await fixture(),before=await db.prepare('SELECT COUNT(*) n FROM public_artifacts').first('n');
 for(const path of ['/',f.path,'/archive/'])for(const format of ['html','markdown']){
  const out=await preview.read(db,{approval_id:f.approval.id,path,format},context);
  expect(out.notice).toBe(preview.NOTICE);expect(out.items).toEqual([{id:f.entry.id,version:f.pending.version}]);expect(out.body).not.toContain('UNRELATED_DRAFT');expect(out.body).not.toContain('Approved baseline.');
  if(path===f.path)expect(out.body).toContain('Pending selected text.');
  expect(out.body).not.toMatch(/(?:href|src|action|style|onload)=|<script|<form|csrf|\/review\//i);
 }
 expect(await db.prepare('SELECT COUNT(*) n FROM public_artifacts').first('n')).toBe(before);
});
it.each(['/review/','/media/','//example.com/','/a/../','/a/%2f/','/a/?q=x','/a/#x','/a/index.md','https://example.com/','/\uD800/'])('preview_path: refuses case %#',async(path)=>{
 await expect(preview.read(db,{approval_id:'abcdefgh',path},context)).rejects.toMatchObject({code:'invalid'});
});
it('preview_authority: absent or revoked authority precedes resource existence',async()=>{
 for(const ctx of [undefined,{origin,authorize:async()=>{throw Error('revoked');}}])await expect(preview.read(db,{approval_id:'abcdefgh'},ctx)).rejects.toMatchObject({code:'unauthorized'});
 const f=await fixture();let calls=0;
 await expect(preview.read(db,{approval_id:f.approval.id}, {origin,authorize:async()=>{if(++calls>=3)throw Error('revoked');return authority;}})).rejects.toMatchObject({code:'unauthorized'});
});
it.each(['live','revision','approval','epoch'])('preview_closure: %s change never returns a body',async(kind)=>{
 const f=await fixture();let calls=0;
 const authorize=async()=>{if(++calls===2){if(kind==='live')await db.prepare("UPDATE live SET data=replace(data,'Inspection site','Changed baseline') WHERE item_id='site'").run();if(kind==='revision')await db.prepare("UPDATE revisions SET data=replace(data,'Pending selected text.','Changed revision.') WHERE item_id=? AND version=?").bind(f.pending.id,f.pending.version).run();if(kind==='approval')await db.prepare("UPDATE approvals SET status='decided' WHERE id=?").bind(f.approval.id).run();}return {...authority,epoch:kind==='epoch'&&calls>=3?1:0};};
 await expect(preview.read(db,{approval_id:f.approval.id,path:f.path},{origin,authorize})).rejects.toMatchObject({code:kind==='epoch'?'unauthorized':'content_changed'});
});
it('preview_stale: superseded pending version refuses',async()=>{const f=await fixture();await content.updateItem(db,actor,f.pending.id,f.pending.version,{title:'Newer title'});await expect(preview.read(db,{approval_id:f.approval.id},context)).rejects.toMatchObject({code:'approval_changed'});});
it('preview_inert: provenance-independent attribute stripping and bounded structural attributes',()=>{
 const source='<html><head><base href="https://bad.example"><link href="x"><script>SECRET_SCRIPT</script></head><body><main><a href="/review/x" ping="x">Visible link</a><img src="/media/draft.png" alt="Draft image"><iframe src="https://bad.example">SECRET_FRAME</iframe><form action="/review/x"><input value="SECRET_CSRF"></form><svg><a href="x">SECRET_SVG</a></svg><table><tr><th scope="row" colspan="2" onclick="x">Cell</th><td rowspan="1001">Other</td></tr></table><ol start="-2" style="color:red"><li>Literal text.</li></ol></main></body></html>';
 const safe=preview.inert(source),md=markdownDocument(safe,origin+'/',false).markdown;
 expect(safe).toContain('<th colspan="2" scope="row">Cell</th>');expect(safe).toContain('<ol start="-2">');
 for(const x of ['href=','src=','onclick','SECRET_','rowspan=','https://','style=','<form','<svg'])expect(safe).not.toContain(x);
 expect(md).toContain('Visible link');expect(md).toContain('Draft image');expect(md).not.toContain(origin);expect(md).not.toContain('](');
});

import worker from '../src/index';
import * as keys from '../src/keys';
import * as readKeys from '../src/read-keys';
import type {Env} from '../src/env';
const execution={waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext;
async function rpc(token:string,method:string,params:any={},fallback=false,configured=true){
 const response=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,...(fallback?{_meta:{test:true}}:{})}})}),{...env,SITE_URL:configured?origin:undefined} as unknown as Env,execution);
 const text=await response.text(),out=JSON.parse(text.startsWith('{')?text:(text.split('\n').find(x=>x.startsWith('data:'))??'data:{}').slice(5));return {response,out};
}
it.each([false,true])('preview_transport: key succeeds, read principal remains draft-blind, fallback=%s',async(fallback)=>{
 const f=await fixture(),key=await keys.create(db,'Drafting'),reader=await readKeys.create(db,'Reading');
 const success=await rpc(key.token,'tools/call',{name:'preview_read',arguments:{approval_id:f.approval.id,path:f.path}},fallback);
 expect(success.out.result.isError).not.toBe(true);expect(JSON.parse(success.out.result.content[0].text).body).toContain('Pending selected text.');expect(success.response.headers.get('Cache-Control')).toBe('private, no-store, no-transform');
 const listed=await rpc(reader.token,'tools/list',{},fallback);expect(listed.out.result.tools).toHaveLength(5);expect(listed.out.result.tools.some((x:any)=>x.name==='preview_read')).toBe(false);
 const refused=await rpc(reader.token,'tools/call',{name:'preview_read',arguments:{approval_id:f.approval.id}},fallback);expect(JSON.stringify(refused.out)).not.toContain('Pending selected text.');expect(refused.out.error||refused.out.result?.isError).toBeTruthy();
 const noOrigin=await rpc(key.token,'tools/call',{name:'preview_read',arguments:{approval_id:f.approval.id}},fallback,false);expect(noOrigin.out.result.isError).toBe(true);expect(JSON.stringify(noOrigin.out)).not.toContain('Pending selected text.');
 await keys.revoke(db,key.id);expect((await rpc(key.token,'tools/call',{name:'preview_read',arguments:{approval_id:f.approval.id}},fallback)).response.status).toBe(401);
});
it('preview_bounds: encoded body cannot be truncated into a successful result',async()=>{
 const f=await fixture(),large=await content.updateItem(db,actor,f.pending.id,f.pending.version,{body:'&'.repeat(60000)}),approval=await approvals.request(db,actor,[large.id],'Large');
 for(const format of ['html','markdown'])await expect(preview.read(db,{approval_id:approval.id,path:f.path,format},context)).rejects.toMatchObject({code:'preview_too_large'});
});
it('preview_clock: proposed notice boundary and rollback fail closed',async()=>{
 const f=await fixture(),site=await content.updateItem(db,actor,'site',f.site.version,{notice:{text:'Only today.',until:'2026-10-18'}}),approval=await approvals.request(db,actor,[site.id,f.pending.id],'Clock');
 for(const [start,end]of [['2026-10-18T23:59:59Z','2026-10-19T00:00:00Z'],['2026-10-18T12:00:00Z','2026-10-18T11:59:59Z']]){
  vi.setSystemTime(new Date(start));let calls=0;
  await expect(preview.read(db,{approval_id:approval.id},{origin,authorize:async()=>{if(++calls===2)vi.setSystemTime(new Date(end));return authority;}})).rejects.toMatchObject({code:'content_changed'});
 }
});

import INERT from '../../spec/fixtures/preview-inert.json';
it.each(INERT)('preview_shared_inert: $name',({source,html})=>expect(preview.inert(source)).toBe(html));
async function oauthWriter(){
 const go=(path:string,init?:RequestInit)=>worker.fetch(new Request(origin+path,init),{...env,SITE_URL:origin} as unknown as Env,execution),redirect='https://app.example/callback';
 const reg=await go('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Inspection app',redirect_uris:[redirect],token_endpoint_auth_method:'none'})});
 const {client_id}=await reg.json() as any,b64=(a:Uint8Array)=>btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const verifier=b64(crypto.getRandomValues(new Uint8Array(32))),challenge=b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))),session='preview-owner-test';
 await db.prepare("INSERT INTO owner(id,name,user_handle,created_at) VALUES(1,'Owner','AA','2026-10-18')").run();
 await db.prepare("INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,'2026-10-18','2099-01-01')").bind(b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(session))))).run();
 const query=new URLSearchParams({response_type:'code',client_id,redirect_uri:redirect,state:'preview',scope:'site:draft',resource:origin+'/mcp',code_challenge:challenge,code_challenge_method:'S256'}),owner='__Host-sk_owner='+session;
 const page=await go('/authorize?'+query,{headers:{Cookie:owner}}),html=await page.text(),handle=/name="handle" value="([^"]+)"/.exec(html)![1],cookie=(page.headers.get('Set-Cookie')??'').split(';')[0];
 const done=await go('/authorize',{method:'POST',headers:{Cookie:owner+'; '+cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,label:'Inspection app',decision:'approve'})});
 const code=new URL(done.headers.get('Location')!).searchParams.get('code')!;
 const token=await go('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirect,client_id,code_verifier:verifier,resource:origin+'/mcp'})});
 expect(token.status).toBe(200);return (await token.json() as any).access_token as string;
}
it('preview_oauth: actual owner consent and live grant reach inert copy',async()=>{
 const f=await fixture(),token=await oauthWriter();
 const result=await rpc(token,'tools/call',{name:'preview_read',arguments:{approval_id:f.approval.id,path:f.path}});
 expect(result.out.result.isError).not.toBe(true);expect(JSON.parse(result.out.result.content[0].text).body).toContain('Pending selected text.');
});
it('preview_private: existing writer authority works without widening anonymous media or owner routes',async()=>{
 const f=await fixture(),hidden=await content.updateItem(db,actor,'site',f.site.version,{private:true});await publish(hidden);
 const key=await keys.create(db,'Drafting'),out=await rpc(key.token,'tools/call',{name:'preview_read',arguments:{approval_id:f.approval.id,path:f.path}});
 expect(out.out.result.isError).not.toBe(true);expect(JSON.parse(out.out.result.content[0].text).body).toContain('Pending selected text.');
 for(const headers of ([{},{Cookie:'__Host-sk_owner=invalid'},{Authorization:'Bearer invalid',Cookie:'__Host-sk_owner=invalid'}] as Record<string,string>[])){
  const response=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{...headers,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'preview_read',arguments:{approval_id:f.approval.id}}})}),{...env,SITE_URL:origin} as unknown as Env,execution);expect(response.status).toBe(401);expect(await response.text()).not.toContain('Pending selected text.');
 }
});
it('preview_purity: only two captured source reads; no artifact preparation even when enabled',async()=>{
 const f=await fixture(),sql:string[]=[],wrapped={prepare(statement:string){sql.push(statement);return db.prepare(statement);}} as D1Database;
 await preview.read(wrapped,{approval_id:f.approval.id,path:f.path},context);expect(sql).toEqual([preview.SNAPSHOT_SQL,preview.SNAPSHOT_SQL]);
 const key=await keys.create(db,'Drafting');
 for(const fallback of [false,true]){
  const tasks:Promise<unknown>[]=[],ctx={...execution,waitUntil(p:Promise<unknown>){tasks.push(p);}} as ExecutionContext;
  const response=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+key.token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'preview_read',arguments:{approval_id:f.approval.id,path:f.path},...(fallback?{_meta:{test:true}}:{})}})}),{...env,SITE_URL:origin,PUBLIC_ARTIFACTS:'1'} as unknown as Env,ctx);
  const text=await response.text();expect(text).toContain('Pending selected text.');expect(tasks).toEqual([]);expect(await db.prepare('SELECT COUNT(*) n FROM public_artifacts').first('n')).toBe(0);
 }
});
it('preview_source: atomically captured inputs render without database helper reads',async()=>{
 const f=await fixture(),rows=await preview.capture(db,f.approval.id),s=preview.view(rows,Date.now());
 const html=await preview.renderPage(s.v,s.t,f.path,origin,'test');expect(html).toContain('Pending selected text.');expect(html).not.toContain('UNRELATED_DRAFT');
});
import {THEMES} from '../src/themes.gen';
it.each([...Object.keys(THEMES),'built-in','inspection-custom'])('preview_looks: %s preserves inert home/entry/combined archive',async(name)=>{
 if(name==='inspection-custom'){
  const look=structuredClone(THEMES['personal-homepage']);look.manifest.name=name;look.pages.home='<html><body><main><h1>{{site.title}}</h1><a href="/review/secret">Visible label</a><img src="/media/draft.png" alt="Draft photo"><script>SECRET_SCRIPT</script></main></body></html>';
  await db.prepare("INSERT INTO themes(name,version,package,sha256,installed_at,installed_by,source) VALUES(?,'1',?,'fixture','2026-10-18','assistant:test','private')").bind(name,JSON.stringify(look)).run();
 }
 const f=await fixture(name);
 for(const path of ['/',f.path,'/archive/'])for(const format of ['html','markdown']){
  const out=await preview.read(db,{approval_id:f.approval.id,path,format},context);expect(out.body).toContain(preview.NOTICE);expect(out.body).not.toMatch(/(?:href|src|action|style)=|<script|SECRET_SCRIPT|\/review\/secret/);
  if(path==='/archive/')expect(out.body).toContain('Selected title');
 }
});
it.each(['field','embed','streams','private','training','theme','share'])('preview_dependency: %s raw change invalidates without a version bump',async(kind)=>{
 const f=await fixture();let calls=0;
 const authorize=async()=>{if(++calls===2){
  if(kind==='field')await db.prepare("INSERT INTO site_fields(version,key,value,approved) VALUES(?,'broker','\"https://broker.example\"',1)").bind(f.site.version).run();
  if(kind==='embed')await db.prepare("UPDATE site_embed_sources SET sources='[\"https://player.example\"]' WHERE version=?").bind(f.site.version).run();
  if(kind==='streams')await db.prepare("UPDATE site_stream_settings SET settings=replace(settings,'All entries','Changed archive') WHERE version=?").bind(f.site.version).run();
  if(kind==='private'||kind==='training')await db.prepare(`INSERT INTO ${kind==='private'?'private_approvals':'training_approvals'}(version) VALUES(?)`).bind(f.site.version).run();
  if(kind==='theme')await db.prepare("INSERT INTO themes(name,version,package,sha256,installed_at,installed_by) VALUES('personal-homepage','1',?,'changed','2026-10-18','assistant:test')").bind(JSON.stringify(THEMES['personal-homepage'])).run();
  if(kind==='share')await db.prepare("INSERT INTO share_cards(item_id,version,name,created_at) VALUES(?,?,'fixture.png','2026-10-18')").bind(f.pending.id,f.pending.version).run();
 }return authority;};
 await expect(preview.read(db,{approval_id:f.approval.id,path:f.path},{origin,authorize})).rejects.toMatchObject({code:'content_changed'});
});
it('preview_media: legacy header dimensions are captured without a write; changing dimensions fences delivery',async()=>{
 const f=await fixture(),name='a'.repeat(32)+'.png',header=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,2,128,0,0,1,224]);
 await db.prepare("INSERT INTO media(name,type,size,chunks,created_at,width,height) VALUES(?,'image/png',24,1,'2026-10-18',0,0)").bind(name).run();await db.prepare('INSERT INTO media_chunks(name,n,data) VALUES(?,0,?)').bind(name,header).run();
 await db.prepare("UPDATE live SET data=json_set(data,'$.hero',?) WHERE item_id='site'").bind('/media/'+name).run();
 const rows=await preview.capture(db,f.approval.id);expect(preview.view(rows,Date.now()).v.hero_size).toEqual([640,480]);
 await preview.read(db,{approval_id:f.approval.id},context);expect(await db.prepare('SELECT width FROM media WHERE name=?').bind(name).first('width')).toBe(0);
 let calls=0;await expect(preview.read(db,{approval_id:f.approval.id},{origin,authorize:async()=>{if(++calls===2)await db.prepare('UPDATE media SET width=100,height=50 WHERE name=?').bind(name).run();return authority;}})).rejects.toMatchObject({code:'content_changed'});
});
it('preview_decisions: partial approval and a selected removal are not a different proposal',async()=>{
 const f=await fixture(),items=f.approval.items.map(x=>({...x,status:'published'}));
 await db.prepare('UPDATE approvals SET items=? WHERE id=?').bind(JSON.stringify(items),f.approval.id).run();await expect(preview.read(db,{approval_id:f.approval.id},context)).rejects.toMatchObject({code:'approval_changed'});
 const removed=await content.removeItem(db,actor,f.pending.id,f.pending.version),approval=await approvals.request(db,actor,[removed.id],'Remove');
 await expect(preview.read(db,{approval_id:approval.id,path:f.path},context)).rejects.toMatchObject({code:'not_found'});
});
it('preview_time_proof: quiet page crosses a minute; unknown proposed clock refuses',async()=>{
 const f=await fixture();let calls=0;
 const quiet=await preview.read(db,{approval_id:f.approval.id},{origin,authorize:async()=>{if(++calls===2)vi.setSystemTime(new Date('2026-10-18T13:01:00Z'));return authority;}});expect(quiet.body).toContain(preview.NOTICE);
 const proposed=await content.updateItem(db,actor,'site',f.site.version,{notice:{text:'Future notice',until:'2200-01-01'}}),approval=await approvals.request(db,actor,[proposed.id,f.pending.id],'Unknown clock');vi.setSystemTime(new Date('2200-01-01T12:00:00Z'));
 await expect(preview.read(db,{approval_id:approval.id},context)).rejects.toMatchObject({code:'preview_unavailable'});
});
it('preview_no_audience: inspecting a draft image never makes it anonymously readable',async()=>{
 const f=await fixture(),name='b'.repeat(32)+'.png',path='/media/'+name,header=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
 await db.prepare("INSERT INTO media(name,type,size,chunks,created_at,width,height) VALUES(?,'image/png',24,1,'2026-10-18',1,1)").bind(name).run();await db.prepare('INSERT INTO media_chunks(name,n,data) VALUES(?,0,?)').bind(name,header).run();
 const item=await content.updateItem(db,actor,f.pending.id,f.pending.version,{body:`![Draft photo](${path})`}),approval=await approvals.request(db,actor,[item.id],'Photo');
 const before=await worker.fetch(new Request(origin+path),{...env,SITE_URL:origin} as unknown as Env,execution);expect(before.status).toBe(404);
 const out=await preview.read(db,{approval_id:approval.id,path:f.path},context);expect(out.body).toContain('Draft photo');expect(out.body).not.toContain(path);
 const after=await worker.fetch(new Request(origin+path),{...env,SITE_URL:origin} as unknown as Env,execution);expect(after.status).toBe(404);
});
const userInfoOrigin=new URL(origin);userInfoOrigin.username='owner';
it.each(['','http://site.example','https://site.example/path','https://site.example:bad',userInfoOrigin.href.slice(0,-1),'https://site.example/?x=1','https://site.example/#fragment'])('preview_origin: invalid configured origin refuses without a request fallback (%s)',async(configured)=>{
 await expect(preview.read(db,{approval_id:'abcdefgh'},{...context,origin:configured})).rejects.toMatchObject({code:'preview_unavailable'});
});

it('preview_refusal_purity: invalid calls and SDK batch envelopes never schedule a public fill',async()=>{
 const f=await fixture(),key=await keys.create(db,'Drafting');
 for(const body of [
  {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'preview_read',arguments:{},_meta:{test:true}}},
  [{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'preview_read',arguments:{approval_id:f.approval.id}}}],
 ]){
  const tasks:Promise<unknown>[]=[],ctx={...execution,waitUntil(p:Promise<unknown>){tasks.push(p);}} as ExecutionContext;
  const response=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+key.token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(body)}),{...env,SITE_URL:origin,PUBLIC_ARTIFACTS:'1'} as unknown as Env,ctx);
  await response.text();expect(tasks).toEqual([]);expect(await db.prepare('SELECT COUNT(*) n FROM public_artifacts').first('n')).toBe(0);
 }
});

it('preview_structural_bounds: huge decimal attributes are omitted without parsing unbounded integers',()=>{
 const safe=preview.inert('<ol start="'+'9'.repeat(5000)+'"><li>Large</li></ol><ol start="'+'0'.repeat(5000)+'2"><li>Leading zeros</li></ol>');
 expect(safe).toContain('<ol><li>Large</li></ol><ol start="2"><li>Leading zeros</li></ol>');
});
