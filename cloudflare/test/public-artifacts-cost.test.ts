import {env} from 'cloudflare:workers';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as read from '../src/public-read';
import * as artifacts from '../src/public-artifacts';
import * as traffic from '../src/agent-traffic';
import {handle} from '../src/routes';
import type {Env} from '../src/env';
import cases from '../../spec/fixtures/public-artifacts-cost.json';
const origin='https://site.example',e={...env,SITE_URL:origin,PUBLIC_ARTIFACTS:'1'} as unknown as Env,db=e.DB;
beforeEach(async()=>{
 vi.restoreAllMocks();traffic.reset(db);
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name}of tables.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id)VALUES(1)').run();
 await db.prepare('INSERT INTO public_artifact_state(id)VALUES(1)').run();
});
afterEach(()=>vi.restoreAllMocks());
async function seed(){
 for(const [kind,data]of [['site',{title:'Cost fixture',archive:{enabled:true}}],['entry',{title:'Page',date:'2026-10-18',body:'Published.',tags:['one']}]] as const){
  const item=await content.createItem(db,'assistant:test',kind,data,undefined);await approvals.publishNow(db,[{id:item.id,version:item.version}],'',origin);
 }
}
const req=()=>new Request(origin+'/');
const legacyStateSQL=()=>`SELECT f.*,(SELECT generation FROM public_artifact_state WHERE id=1) AS generation,(SELECT revision FROM public_artifact_state WHERE id=1) AS revision FROM (${read.FACTS_SQL}) f`;
it('af_c1_state_once: complete source, raw tuples, hashes and approved proof match the old transport',async()=>{
 await seed();await db.prepare("UPDATE public_artifact_state SET generation='observed-only',revision=37 WHERE id=1").run();
 const legacy=(await db.prepare(legacyStateSQL()).all<read.Row>()).results,old=read.decode(legacy),f=await read.preparationFacts(db),wire=(await db.prepare(read.FACTS_STATE_SQL).all<read.Row>()).results;
 expect(wire.filter(x=>x.category==='artifact_state')).toEqual([{category:'artifact_state',ident:'site',value:'["observed-only",37]'}]);
 expect(f.rows).toEqual(old.rows);expect(f.site).toEqual(old.site);expect(f.raw).toEqual(legacy.map(x=>[x.category,x.ident,x.value]));expect(f.generation).toBe('observed-only');expect(f.revision).toBe(37);
 expect(read.viewProof(f)).toEqual(read.viewProof(old));const c=read.choice(req(),f)!;
 expect(await read.tag(f,req(),c,'fixture',0)).toBe(await read.tag(old,req(),c,'fixture',0));expect(await artifacts.generation(f,'fixture',origin)).toBe(await artifacts.generation(old,'fixture',origin));
 expect(JSON.stringify(f.rows)).not.toContain('artifact_state');expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(legacy).length);
 const prepare=vi.spyOn(db,'prepare');await read.facts(db);expect(prepare.mock.calls.map(([q])=>q)).toEqual([read.FACTS_SQL]);
});
it.each([0,1,203])('af_c1_state_once: %i dependencies survive extraction without a state tuple entering F',async n=>{
 await seed();const rows=(await db.prepare(read.FACTS_SQL).all<read.Row>()).results,site=rows.find(r=>r.category==='live'&&r.ident==='site')!,entry=rows.find(r=>r.category==='live'&&r.ident!=='site')!;
 const dependencies=n?[site,...Array.from({length:n-1},(_,i)=>({...entry,ident:'entry-'+i}))]:[];
 const transport=[{category:'artifact_state',ident:'site',value:'["state",1]'},...dependencies];const prepare=vi.fn(()=>({all:async()=>({results:transport})}));
 const f=await read.preparationFacts({prepare} as unknown as D1Database);expect(f.rows).toEqual(read.decode(dependencies).rows);expect(f.raw).toHaveLength(n);expect(f.generation).toBe('state');expect(prepare).toHaveBeenCalledTimes(1);
});
it.each(['absent','duplicate','bad-json','wrong-id','wrong-length','boolean-revision'])('af_c1_state_once: %s state cannot provide a matching generation',async mode=>{
 await seed();const rows=(await db.prepare(read.FACTS_SQL).all<read.Row>()).results,state={category:'artifact_state',ident:'site',value:'["state",1]'};
 const states=mode==='absent'?[]:mode==='duplicate'?[state,state]:[{...state,...(mode==='wrong-id'?{ident:'other'}:{}),value:mode==='bad-json'?'{':mode==='wrong-length'?'["state"]':mode==='boolean-revision'?'["state",true]':state.value}];
 const f=await read.preparationFacts({prepare:()=>({all:async()=>({results:[...states,...rows]})})} as unknown as D1Database);
 expect(f.rows).toEqual(read.decode(rows).rows);expect(f.raw).toEqual(rows.map(r=>[r.category,r.ident,r.value]));expect(f.generation).toBeUndefined();expect(f.revision).toBeUndefined();
});
it('af_c1_state_once: unavailable state query retains the ordinary facts fallback',async()=>{
 await seed();const prepare=db.prepare.bind(db),calls:string[]=[];
 const f=await read.preparationFacts({prepare:(q:string)=>{calls.push(q);if(q===read.FACTS_STATE_SQL)throw Error('unavailable state');return prepare(q);}} as unknown as D1Database);
 expect(calls).toEqual([read.FACTS_STATE_SQL,read.FACTS_SQL]);expect(f.generation).toBeUndefined();expect(f.rows).toEqual((await read.facts(db)).rows);
});
it.each(cases)('af_c1_grouped_proof: $name withholds both delivery and conditional insertion',async c=>{
 await seed();expect((await handle(req(),e)).status).toBe(200);const f=await read.facts(db,true),row=await db.prepare('SELECT * FROM public_artifacts LIMIT 1').first<any>(),raw=f.raw!.map(x=>[...x]) as any[][];
 let g=row.generation;
 if(c.change==='duplicate')raw.push(raw[0]);else if(c.change==='missing')raw.shift();else if(c.change==='additional')raw.push(['live','not-current','[]']);else if(c.change==='replace')raw[0]=raw[1];else if(c.change==='raw')raw[0][2]+=' ';else if(c.change==='null')raw[0][2]=null;else if(c.change==='generation')g='wrong';else if(c.change==='source')await db.prepare("UPDATE live SET data=json_set(data,'$.title','In place') WHERE item_id='site'").run();
 const result=await db.prepare(artifacts.lookupSQL()).bind(JSON.stringify(raw),g,row.key,g).first<any>();expect(!!result.ok).toBe(c.allowed);expect(result.body).toBe(c.allowed?row.body:null);
 const key='conditional-control';await db.prepare(artifacts.proofSQL()+' INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size) SELECT ?,?,?,?,?,? FROM proof WHERE ok').bind(JSON.stringify(raw),g,key,g,row.body,row.metadata,row.valid_until,row.size).run();
 expect(Number(await db.prepare('SELECT count(*) n FROM public_artifacts WHERE key=?').bind(key).first('n'))).toBe(c.allowed?1:0);
});

it.each(['GET','HEAD'])('af_c2_304: %s uses exact OFF SQL and bindings with copies ON, even without optional tables',async method=>{
 await seed();const first=await handle(req(),{...e,PUBLIC_ARTIFACTS:''}),tag=first.headers.get('ETag')!;await first.text();
 const original=db.prepare.bind(db);
 for(const missing of [false,true]){
  if(missing)await db.prepare('ALTER TABLE public_artifact_state RENAME TO absent_copy_state').run();
  try{for(const match of [tag,'*']){
   const run=async(on:boolean)=>{
    traffic.reset(db);const calls:{sql:string;binds:unknown[]}[]=[];
    const spy=vi.spyOn(db,'prepare').mockImplementation((sql:string)=>{const statement=original(sql),row={sql,binds:[] as unknown[]};calls.push(row);const bind=statement.bind.bind(statement);vi.spyOn(statement,'bind').mockImplementation((...values:unknown[])=>{row.binds=values;return bind(...values);});return statement;});
    try{const response=await handle(new Request(origin+'/',{method,headers:{'If-None-Match':match}}),{...e,PUBLIC_ARTIFACTS:on?'1':''});return {status:response.status,body:await response.text(),headers:[...response.headers],calls};}finally{spy.mockRestore();}
   };
   const off=await run(false),on=await run(true);expect(on).toEqual(off);expect(on.status).toBe(304);expect(on.body).toBe('');expect(on.calls.filter(x=>x.sql===read.FACTS_SQL)).toHaveLength(2);expect(on.calls.some(x=>/public_artifact/.test(x.sql))).toBe(false);
  }}finally{if(missing)await db.prepare('ALTER TABLE absent_copy_state RENAME TO public_artifact_state').run();}
 }
});
it('af_c2_facts: visitor ON captures raw tuples from ordinary SQL without state, preparation remains separate',async()=>{
 await seed();const prepare=vi.spyOn(db,'prepare'),f=await read.facts(db,true);expect(prepare.mock.calls.map(([sql])=>sql)).toEqual([read.FACTS_SQL]);expect(f.raw).toEqual((await originalRows()).map(r=>[r.category,r.ident,r.value]));expect(f.generation).toBeUndefined();expect(f.revision).toBeUndefined();
 prepare.mockClear();await read.preparationFacts(db);expect(prepare.mock.calls.map(([sql])=>sql)).toEqual([read.FACTS_STATE_SQL]);
 async function originalRows(){return (await db.prepare(read.FACTS_SQL).all<read.Row>()).results;}
});
it.each(['missing','generation','revision'])('af_c2_lookup: %s state withholds body while preserving tuple equality',async mode=>{
 await seed();await handle(req(),e);const f=await read.facts(db,true),old=await db.prepare('SELECT * FROM public_artifacts LIMIT 1').first<any>();expect(old).toBeTruthy();
 if(mode==='missing')await db.prepare('DELETE FROM public_artifact_state').run();else if(mode==='generation')await db.prepare("UPDATE public_artifact_state SET generation='stale' WHERE id=1").run();else await db.prepare("UPDATE public_artifact_state SET revision='bad' WHERE id=1").run();
 const rows=(await db.prepare(artifacts.lookupSQL()).bind(JSON.stringify(f.raw),old.generation,old.key,old.generation).all<any>()).results;
 expect(rows).toHaveLength(1);expect(rows[0].facts_ok).toBe(1);expect(rows[0].ok).toBe(0);expect(rows[0].key).toBeNull();expect(rows[0].body).toBeNull();
});
it('af_c2_lookup: tuple drift after matching advisory state and refreshes instead of synchronizing a stale capture',async()=>{
 await seed();await handle(req(),e);const f=await read.facts(db,true),c=read.choice(req(),f)!,now=Date.now(),tag=await read.tag(f,req(),c,'fixture',now);
 await db.prepare("UPDATE live SET data=json_set(data,'$.title','Changed without version') WHERE item_id='site'").run();await db.prepare('UPDATE public_artifact_state SET generation=? WHERE id=1').bind(await artifacts.generation(f,'fixture',origin)).run();
 const render=vi.fn(async()=>new Response('incorrect render')),refresh=vi.fn(async()=>new Response('fresh'));
 const response=await artifacts.respond(db,req(),origin,'fixture',render,{facts:f,choice:c,tag,now},refresh);
 expect(await response.text()).toBe('fresh');expect(refresh).toHaveBeenCalledTimes(1);expect(render).not.toHaveBeenCalled();expect(await db.prepare('SELECT count(*) n FROM public_artifacts').first('n')).toBe(0);expect(await db.prepare('SELECT generation FROM public_artifact_state WHERE id=1').first('generation')).toBe('');
});
it('af_c2_lookup: inconsistent returned proof cannot serve or render a selected body',async()=>{
 await seed();const f=await read.facts(db,true),c=read.choice(req(),f)!,now=Date.now(),tag=await read.tag(f,req(),c,'fixture',now),prepare=db.prepare.bind(db);
 const fake={prepare:(sql:string)=>sql===artifacts.STATE_SQL?{all:async()=>({results:[]})}:sql===artifacts.lookupSQL()?{bind:()=>({all:async()=>({results:[{facts_ok:0,ok:1,generation:'stale',revision:0,key:'bad',body:'must not serve',metadata:'[]',valid_until:Date.now()+10000}]})})}:prepare(sql)} as unknown as D1Database;
 const render=vi.fn(async()=>new Response('incorrect render')),refresh=vi.fn(async()=>new Response('fresh'));
 expect(await(await artifacts.respond(fake,req(),origin,'fixture',render,{facts:f,choice:c,tag,now},refresh)).text()).toBe('fresh');expect(refresh).toHaveBeenCalledTimes(1);expect(render).not.toHaveBeenCalled();
});

it('af_c2_advisory_match_race: generation changed after observation still withholds body and purges',async()=>{
 await seed();await handle(req(),e);const f=await read.facts(db,true),c=read.choice(req(),f)!,{RELEASE}=await import('../src/home'),now=Date.now(),tag=await read.tag(f,req(),c,RELEASE,now),prepare=db.prepare.bind(db);let refused:any;
 const fake={prepare:(sql:string)=>{
  const statement=prepare(sql);
  if(sql===artifacts.lookupSQL()){
   const bind=statement.bind.bind(statement);statement.bind=((...args:unknown[])=>{const bound=bind(...args),all=bound.all.bind(bound);bound.all=(async()=>{await prepare("UPDATE public_artifact_state SET generation='changed after advisory' WHERE id=1").run();const result=await all();refused=result.results[0];return result;}) as typeof bound.all;return bound;}) as typeof statement.bind;
  }return statement;
 },batch:db.batch.bind(db)} as unknown as D1Database;
 const render=vi.fn(async()=>new Response('live MISS')),refresh=vi.fn(async()=>new Response('fresh'));
 const response=await artifacts.respond(fake,req(),origin,RELEASE,render,{facts:f,choice:c,tag,now},refresh);
 expect(await response.text()).toBe('live MISS');expect(render).toHaveBeenCalledTimes(1);expect(refresh).not.toHaveBeenCalled();expect(refused.facts_ok).toBe(1);expect(refused.ok).toBe(0);expect(refused.body).toBeNull();expect(await db.prepare('SELECT count(*) n FROM public_artifacts').first('n')).toBe(0);
});
it.each(['boolean','null','duplicate','unavailable','missing'])('af_c2_advisory_shape: %s cannot authorize a HIT',async mode=>{
 await seed();const f=await read.facts(db,true),c=read.choice(req(),f)!,now=Date.now(),tag=await read.tag(f,req(),c,'fixture',now),g=await artifacts.generation(f,'fixture',origin),prepare=db.prepare.bind(db),queries:string[]=[];
 const fake={prepare:(sql:string)=>{queries.push(sql);if(sql!==artifacts.STATE_SQL)return prepare(sql);return {all:async()=>{if(mode==='unavailable')throw Error('missing table');return {results:mode==='missing'?[]:mode==='duplicate'?[{generation:g,revision:1},{generation:g,revision:1}]:[{generation:g,revision:mode==='boolean'?true:null}]};}};},batch:db.batch.bind(db)} as unknown as D1Database;
 const render=vi.fn(async()=>new Response('live MISS')),refresh=vi.fn(async()=>new Response('fresh'));
 const response=await artifacts.respond(fake,req(),origin,'fixture',render,{facts:f,choice:c,tag,now},refresh);
 if(mode==='missing'){expect(queries).toContain(artifacts.lookupSQL());expect(await response.text()).toBe('live MISS');expect(render).toHaveBeenCalledTimes(1);expect(refresh).not.toHaveBeenCalled();}
 else{expect(queries).not.toContain(artifacts.lookupSQL());expect(await response.text()).toBe('fresh');expect(refresh).toHaveBeenCalledTimes(1);expect(render).not.toHaveBeenCalled();}
});
