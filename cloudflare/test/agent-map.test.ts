import {env} from 'cloudflare:workers';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {Env} from '../src/env';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as site from '../src/site';
import * as theme from '../src/theme';
import * as markdown from '../src/agent-markdown';
import {handle} from '../src/routes';
import {SIGN_IN} from '../src/privacy';
const e=env as unknown as Env,db=e.DB,origin='https://site.example',actor='assistant:test';
beforeEach(async()=>{
 vi.restoreAllMocks();
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name} of tables.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();
});
afterEach(()=>vi.restoreAllMocks());
async function seed(n:number){
 const item=await content.createItem(db,actor,'site',{title:'Published title',description:'Approved description',tagline:'Different visible heading',theme:'personal-homepage',archive:{enabled:true,title:'All entries'}},undefined);
 await approvals.publishNow(db,[{id:'site',version:1}],'',origin);
 const statements=[];
 for(let i=0;i<n;i++){
  const id='ent_'+i,slug='page-'+String(i).padStart(3,'0'),stamp=new Date(Date.UTC(2026,9,17,12,0,i)).toISOString(),data=JSON.stringify(content.validate('entry',{title:'Entry '+i,date:'2026-10-17',summary:i%2?'Summary '+i:'',body:'Body only marker '+('long body '.repeat(200))}));
  statements.push(db.prepare("INSERT INTO items(id,kind,slug,version,data,deleted,created_at,updated_at) VALUES (?,'entry',?,1,?,0,?,?)").bind(id,slug,data,stamp,stamp),db.prepare("INSERT INTO live(item_id,kind,slug,version,data,published_at) VALUES (?,'entry',?,1,?,?)").bind(id,slug,data,stamp));
 }
 for(let i=0;i<statements.length;i+=40)await db.batch(statements.slice(i,i+40));
 await content.updateItem(db,actor,'site',item.version,{title:'PENDING_TITLE_CANARY'});
}
it.each([2,200])('af_ll1_constant_queries: %i entries, one reader view, no full page/Markdown work on 200 or 304',async(n)=>{
 await seed(n);const render=vi.spyOn(theme,'render'),convert=vi.spyOn(markdown,'markdownDocument'),load=vi.spyOn(site,'liveView'),prepare=vi.spyOn(db,'prepare');
 const call=async(method:string,tag?:string)=>{prepare.mockClear();load.mockClear();render.mockClear();convert.mockClear();const r=await handle(new Request(origin+'/llms.txt',{method,headers:tag?{'If-None-Match':tag}:{}}),{...e,PUBLIC_ARTIFACTS:''});const body=await r.text();const calls=prepare.mock.calls.map(([sql])=>sql);expect(calls.length).toBeLessThanOrEqual(16);const conditional=!!tag;expect(calls.filter(sql=>sql.startsWith('SELECT l.*, i.created_at FROM live'))).toHaveLength(conditional?0:1);expect(load).toHaveBeenCalledTimes(conditional?0:1);if(conditional)expect(calls.length).toBeLessThanOrEqual(3);expect(render).not.toHaveBeenCalled();expect(convert).not.toHaveBeenCalled();return {r,body,calls};};
 const {r,body}=await call('GET');expect(r.status).toBe(200);expect(body.startsWith('# Published title\n\nApproved description\n\n')).toBe(true);expect(body).not.toContain('PENDING_TITLE_CANARY');expect(body).not.toContain('Body only marker');expect(body).not.toContain('Different visible heading');expect([...body.matchAll(/^- \[/gm)]).toHaveLength(Math.min(n+2,50));expect(body).toContain('- [All entries](<'+origin+'/archive/index.md>)\n');
 const tag=r.headers.get('ETag')!;for(const method of ['GET','HEAD']){const next=await call(method,tag);expect(next.r.status).toBe(304);expect(next.body).toBe('');expect(next.r.headers.get('ETag')).toBe(tag);}
});
it('af_ll1_access_and_publication: session isolation, private gate before view, and old map tag cannot survive removal',async()=>{
 await seed(2);const first=await handle(new Request(origin+'/llms.txt'),e),tag=first.headers.get('ETag')!;
 for(const headers of [{Cookie:'__Host-sk_owner=invalid'},{Cookie:'__Host-sk_reader=invalid'},{Authorization:'Bearer invalid'}] as Record<string,string>[]){const r=await handle(new Request(origin+'/llms.txt',{headers:{...headers,'If-None-Match':tag}}),e);expect(r.status).toBe(200);expect(r.headers.get('Cache-Control')).toBe('private, no-store, no-transform');expect(r.headers.has('ETag')).toBe(false);}
 await db.prepare("DELETE FROM live WHERE kind='entry'").run();const removed=await handle(new Request(origin+'/llms.txt',{headers:{'If-None-Match':tag}}),e);expect(removed.status).toBe(200);expect(await removed.text()).not.toContain('/journal/page-');
 const updated=await content.updateItem(db,actor,'site',2,{private:true});await approvals.publishNow(db,[{id:'site',version:updated.version}],'',origin);const load=vi.spyOn(site,'liveView');
 for(const method of ['GET','HEAD']){const r=await handle(new Request(origin+'/llms.txt',{method,headers:{'If-None-Match':tag}}),e);expect(r.status).toBe(404);expect(await r.text()).toBe(method==='HEAD'?'':SIGN_IN);expect(r.headers.has('ETag')).toBe(false);}expect(load).not.toHaveBeenCalled();
});
it('af_ll1_archive_query_shape: archive uses constant view lookups rather than one per entry',async()=>{
 await seed(200);const load=vi.spyOn(site,'liveView'),prepare=vi.spyOn(db,'prepare');const r=await handle(new Request(origin+'/archive/'),e);expect(r.status).toBe(200);await r.text();expect(load.mock.calls.length).toBeLessThanOrEqual(2);expect(prepare.mock.calls.length).toBeLessThanOrEqual(24);
});
