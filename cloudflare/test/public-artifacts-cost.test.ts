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
 const legacy=(await db.prepare(legacyStateSQL()).all<read.Row>()).results,old=read.decode(legacy),f=await read.facts(db,true),wire=(await db.prepare(read.FACTS_STATE_SQL).all<read.Row>()).results;
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
 const f=await read.facts({prepare} as unknown as D1Database,true);expect(f.rows).toEqual(read.decode(dependencies).rows);expect(f.raw).toHaveLength(n);expect(f.generation).toBe('state');expect(prepare).toHaveBeenCalledTimes(1);
});
it.each(['absent','duplicate','bad-json','wrong-id','wrong-length','boolean-revision'])('af_c1_state_once: %s state cannot provide a matching generation',async mode=>{
 await seed();const rows=(await db.prepare(read.FACTS_SQL).all<read.Row>()).results,state={category:'artifact_state',ident:'site',value:'["state",1]'};
 const states=mode==='absent'?[]:mode==='duplicate'?[state,state]:[{...state,...(mode==='wrong-id'?{ident:'other'}:{}),value:mode==='bad-json'?'{':mode==='wrong-length'?'["state"]':mode==='boolean-revision'?'["state",true]':state.value}];
 const f=await read.facts({prepare:()=>({all:async()=>({results:[...states,...rows]})})} as unknown as D1Database,true);
 expect(f.rows).toEqual(read.decode(rows).rows);expect(f.raw).toEqual(rows.map(r=>[r.category,r.ident,r.value]));expect(f.generation).toBeUndefined();expect(f.revision).toBeUndefined();
});
it('af_c1_state_once: unavailable state query retains the ordinary facts fallback',async()=>{
 await seed();const prepare=db.prepare.bind(db),calls:string[]=[];
 const f=await read.facts({prepare:(q:string)=>{calls.push(q);if(q===read.FACTS_STATE_SQL)throw Error('unavailable state');return prepare(q);}} as unknown as D1Database,true);
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
