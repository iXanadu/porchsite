import {env} from 'cloudflare:workers';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {Env} from '../src/env';
import * as media from '../src/media';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as site from '../src/site';
import * as theme from '../src/theme';
import * as traffic from '../src/agent-traffic';
import {imageAdd} from '../src/image-add';
import {handle} from '../src/routes';
const e={...env,PUBLIC_ARTIFACTS:''} as unknown as Env,db=e.DB,origin='https://site.example';
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,2,0,0,0,1,0]);
beforeEach(async()=>{vi.restoreAllMocks();traffic.reset(db);const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();for(const {name}of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();await db.prepare('INSERT INTO auth_state(id)VALUES(1)').run();await db.prepare('INSERT INTO public_artifact_state(id)VALUES(1)').run();});
afterEach(()=>vi.restoreAllMocks());
async function unsized(){const path=await media.store(db,png,'image/png','fixture'),name=path.slice(7);await db.prepare('UPDATE media SET width=0,height=0 WHERE name=?').bind(name).run();return {path,name};}
async function prepared(){await db.prepare("INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size)VALUES('retained','generation','body','{}',9999999999999,4)").run();}
it('perf3_read_only_size: legacy reads preserve dimensions and prepared state',async()=>{
 const {name}=await unsized();await prepared();const before=await db.prepare('SELECT * FROM public_artifact_state').all();const sql=vi.spyOn(db,'prepare');
 expect(await media.sizeOf(db,name)).toEqual([512,256]);expect(await media.sizeOf(db,name)).toEqual([512,256]);expect(sql.mock.calls.every(([q])=>/^SELECT/i.test(q))).toBe(true);sql.mockRestore();
 expect(await db.prepare('SELECT width FROM media WHERE name=?').bind(name).first('width')).toBe(0);expect((await db.prepare('SELECT * FROM public_artifact_state').all()).results).toEqual(before.results);expect(await db.prepare('SELECT count(*) AS n FROM public_artifacts').first('n')).toBe(1);
 expect(await media.sizeOf(db,'absent.png')).toEqual([0,0]);
});
it.each(['store','image_add'])('perf3_upload_backfill: %s records dimensions and atomically clears prepared copies',async(mode)=>{
 const {path,name}=await unsized();await prepared();
 if(mode==='store')expect(await media.store(db,png,'image/png','fixture')).toBe(path);
 else expect((await imageAdd(db,'assistant:test',undefined,[png.toBase64()])).images).toEqual([{image:path,width:512,height:256}]);
 expect(await db.prepare('SELECT width,height FROM media WHERE name=?').bind(name).first()).toEqual({width:512,height:256});expect(await db.prepare('SELECT count(*) AS n FROM public_artifacts').first('n')).toBe(0);expect(await db.prepare('SELECT revision FROM public_artifact_state').first('revision')).toBe(1);
 expect(new Uint8Array(await (await media.serve(db,name,true))!.arrayBuffer())).toEqual(png);
});
it('perf3_legacy_hero_get_head: no writes, one render; matching 304 skips image bytes',async()=>{
 const {path,name}=await unsized();const item=await content.createItem(db,'assistant:test','site',{title:'Legacy hero',theme:'personal-homepage',hero:path,hero_alt:'A wide image'},undefined);await approvals.publishNow(db,[{id:'site',version:item.version}],'',origin);
 const req=(method='GET',tag?:string)=>handle(new Request(origin+'/',{method,headers:tag?{'If-None-Match':tag}:{}}),e);
 await req(); // Prime the unrelated UC9 buffer before measuring read-only rendering.
 await prepared();const load=vi.spyOn(site,'liveView'),render=vi.spyOn(theme,'render'),sql=vi.spyOn(db,'prepare');let tag='';
 for(const method of ['GET','HEAD']){load.mockClear();render.mockClear();sql.mockClear();const response=await req(method);expect(response.status).toBe(200);tag=response.headers.get('ETag')!;expect(load).toHaveBeenCalledTimes(1);expect(render).toHaveBeenCalledTimes(1);expect(sql.mock.calls.length).toBeLessThanOrEqual(14);expect(sql.mock.calls.every(([q])=>!/^\s*(INSERT|UPDATE|DELETE)/i.test(q))).toBe(true);if(method==='GET')expect(await response.text()).toContain('width="512"');else expect(await response.text()).toBe('');}
 load.mockClear();sql.mockClear();const hit=await req('GET',tag);expect(hit.status).toBe(304);expect(await hit.text()).toBe('');expect(load).not.toHaveBeenCalled();expect(sql.mock.calls.length).toBeLessThanOrEqual(3);expect(sql.mock.calls.every(([q])=>!q.includes('media_chunks'))).toBe(true);sql.mockRestore();expect(await db.prepare('SELECT width FROM media WHERE name=?').bind(name).first('width')).toBe(0);expect(await db.prepare('SELECT count(*) AS n FROM public_artifacts').first('n')).toBe(1);
});
it.each([['classic','personal-homepage'],['broadsheet','product-page'],['custom-look','custom-look']])('perf3_bounded_facts: %s selects only its theme and hero from a large library',async(asked,selected)=>{
 const {path,name}=await unsized();const item=await content.createItem(db,'assistant:test','site',{title:'Dependency test',theme:asked,hero:path,hero_alt:'Hero'},undefined);await approvals.publishNow(db,[{id:'site',version:item.version}],'',origin);
 const read=await import('../src/public-read');
 const others=Array.from({length:500},(_,i)=>i.toString(16).padStart(32,'0')+'.png');
 await db.prepare("INSERT INTO media(name,type,size,chunks,source,created_at,width,height)SELECT value,'image/png',0,0,'fixture','2026-10-17',1,1 FROM json_each(?)").bind(JSON.stringify(others)).run();
 await db.prepare("INSERT INTO themes(name,version,package,sha256,installed_at,installed_by)VALUES(?,'1','{}','selected-digest','2026-10-17','assistant:test'),('unused-look','1','{}','unused-digest','2026-10-17','assistant:test')").bind(selected).run();
 const req=new Request(origin+'/'),first=await read.facts(db),choice=read.choice(req,first)!;
 expect(first.rows.filter((r:any)=>r[0]==='media')).toEqual([['media',name,[0,0]]]);expect(first.rows.filter((r:any)=>r[0]==='theme')).toEqual([['theme',selected,['1','selected-digest']]]);
 const tag=await read.tag(first,req,choice,'test',0);
 await db.prepare("UPDATE media SET width=2 WHERE name<>?").bind(name).run();await db.prepare("UPDATE themes SET sha256='unused-new' WHERE name='unused-look'").run();expect(await read.tag(await read.facts(db),req,choice,'test',0)).toBe(tag);
 await db.prepare('UPDATE media SET width=512,height=256 WHERE name=?').bind(name).run();const resized=await read.tag(await read.facts(db),req,choice,'test',0);expect(resized).not.toBe(tag);
 await db.prepare("UPDATE themes SET sha256='selected-new' WHERE name=?").bind(selected).run();expect(await read.tag(await read.facts(db),req,choice,'test',0)).not.toBe(resized);
 const plan=await db.prepare('EXPLAIN QUERY PLAN '+read.FACTS_SQL).all<{detail:string}>();expect(plan.results.some(r=>/SEARCH media USING INDEX.*name=\?/.test(r.detail))).toBe(true);expect(plan.results.some(r=>/SEARCH themes USING INDEX.*name=\?/.test(r.detail))).toBe(true);
});
it('perf3_local_hero_pattern: empty, hotlink and malformed local paths yield no dimension facts',async()=>{
 const item=await content.createItem(db,'assistant:test','site',{title:'Local paths'},undefined);await approvals.publishNow(db,[{id:'site',version:item.version}],'',origin);const read=await import('../src/public-read');
 for(const hero of ['', 'https://example.com/photo.png', '/media/not-a-hash.png','/media/'+'A'.repeat(32)+'.png','/media/'+'b'.repeat(32)+'.gif']){
  if(hero)await db.prepare("INSERT OR IGNORE INTO media(name,type,size,chunks,source,created_at,width,height)VALUES(?,'image/png',0,0,'fixture','2026-10-17',512,256)").bind(hero.slice(7)).run();
  await db.prepare("UPDATE live SET data=json_set(data,'$.hero',?) WHERE item_id='site'").bind(hero).run();expect((await read.facts(db)).rows.filter((r:any)=>r[0]==='media')).toEqual([]);
 }
 for(const ext of ['jpg','png','webp']){const name='c'.repeat(32)+'.'+ext;await db.prepare("INSERT INTO media(name,type,size,chunks,source,created_at,width,height)VALUES(?,'image/png',0,0,'fixture','2026-10-17',512,256)").bind(name).run();await db.prepare("UPDATE live SET data=json_set(data,'$.hero',?) WHERE item_id='site'").bind('/media/'+name).run();expect((await read.facts(db)).rows.filter((r:any)=>r[0]==='media')).toEqual([['media',name,[512,256]]]);}
});
