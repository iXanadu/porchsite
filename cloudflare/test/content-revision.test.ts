import {env} from 'cloudflare:workers';
import {beforeEach,expect,it,vi} from 'vitest';
import type {Env} from '../src/env';
import * as revision from '../src/content-revision';
import * as read from '../src/public-read';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import {handle} from '../src/routes';
import fixture from '../../spec/fixtures/content-revision.json';
const e={...env,PUBLIC_ARTIFACTS:'',PUBLIC_RESPONSES:'',SITE_URL:'https://site.example'} as unknown as Env,db=e.DB,origin=e.SITE_URL!;
const get=(headers:Record<string,string>={},method='GET',settings=e)=>handle(new Request(origin+'/',{method,headers}),settings);
const pair=async()=>JSON.parse((await revision.readRevision(db))!) as [string,string];
beforeEach(async()=>{
 vi.restoreAllMocks();vi.useRealTimers();
 const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>()).results;
 for(const {name} of tables)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();
 // An ordinary covered write, not a test-only witness reseed.
 await db.prepare('INSERT INTO private_approvals(version) VALUES(999999)').run();await db.prepare('DELETE FROM private_approvals WHERE version=999999').run();
});
async function site(){const item=await content.createItem(db,'assistant:test','site',{title:'Before witness',theme:'personal-homepage'},undefined);await approvals.publishNow(db,[{id:item.id,version:item.version}],'',origin);return item;}
it('validates canonical counter and epoch values without Number rounding',()=>{
 for(const value of fixture.counter_valid)expect(revision.canonicalCounter(value)).toBe(true);
 for(const value of fixture.counter_invalid)expect(revision.canonicalCounter(value)).toBe(false);
 expect(revision.canonicalEpoch(fixture.epoch_valid)).toBe(true);for(const value of fixture.epoch_invalid)expect(revision.canonicalEpoch(value)).toBe(false);
});
it.each(fixture.tables)('covers every I/U/D and every column on $table',async({table,insert})=>{
 let [epoch,n]=await pair();await db.prepare(insert).run();let current=await pair();expect(current).toEqual([epoch,String(BigInt(n)+1n)]);
 const columns=(await db.prepare(`PRAGMA table_info(${table})`).all<{name:string}>()).results;
 for(const {name} of columns){expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);[epoch,n]=await pair();await db.prepare(`UPDATE ${table} SET ${name}=${name}`).run();expect(await pair()).toEqual([epoch,String(BigInt(n)+(table==='items'?0n:1n))]);}
 [epoch,n]=await pair();await db.prepare(`DELETE FROM ${table}`).run();expect(await pair()).toEqual([epoch,String(BigInt(n)+1n)]);
});
it('repairs deleted state, rotates overflow and rolls content plus witness back together',async()=>{
 const old=await pair();await db.prepare('DELETE FROM content_revision').run();expect(await revision.readRevision(db)).toBeNull();
 await db.prepare('INSERT INTO private_approvals(version) VALUES(7)').run();const fresh=await pair();expect(fresh[0]).not.toBe(old[0]);expect(fresh[1]).toBe('1');
 await db.prepare("UPDATE content_revision SET n=9223372036854775807").run();await db.prepare('UPDATE private_approvals SET version=version').run();const rotated=await pair();expect(rotated[0]).not.toBe(fresh[0]);expect(rotated[1]).toBe('1');
 await expect(db.batch([db.prepare('INSERT INTO private_approvals(version) VALUES(8)'),db.prepare('INSERT INTO private_approvals(version) VALUES(7)')])).rejects.toThrow();
 expect(await pair()).toEqual(rotated);expect(await db.prepare('SELECT count(*) n FROM private_approvals WHERE version=8').first('n')).toBe(0);
 const before=await pair();await db.prepare('INSERT OR REPLACE INTO private_approvals(version) VALUES(7)').run();expect((await pair())[0]).toBe(before[0]);expect(BigInt((await pair())[1])).toBeGreaterThan(BigInt(before[1]));
});
it('keeps exact bytes/tags with one combined initial snapshot and one independent late pair read',async()=>{
 await site();const baseRead=revision.readRevision,baseInitial=revision.initialFacts;vi.spyOn(revision,'initialFacts').mockImplementation(async binding=>({facts:await read.facts(binding),pair:null}));const legacy=await get(),body=await legacy.text(),headers=[...legacy.headers];vi.restoreAllMocks();const initial=vi.spyOn(revision,'initialFacts').mockImplementation(baseInitial);
 const witness=vi.spyOn(revision,'readRevision').mockImplementation(baseRead),facts=vi.spyOn(read,'facts');const response=await get();expect(await response.text()).toBe(body);expect([...response.headers]).toEqual(headers);expect(facts).not.toHaveBeenCalled();expect(initial).toHaveBeenCalledTimes(1);expect(witness).toHaveBeenCalledTimes(1);
 facts.mockClear();initial.mockClear();witness.mockClear();const conditional=await get({'If-None-Match':response.headers.get('ETag')!},'HEAD');expect(conditional.status).toBe(304);expect(await conditional.text()).toBe('');expect(facts).not.toHaveBeenCalled();expect(initial).toHaveBeenCalledTimes(1);expect(witness).toHaveBeenCalledTimes(1);
});
it('refuses equal counter values with different epochs after a late old-runtime edit',async()=>{
 await site();await db.prepare('UPDATE content_revision SET n=1').run();const before=await pair(),original=revision.readRevision;let calls=0;
 vi.spyOn(revision,'readRevision').mockImplementation(async binding=>{
  if(++calls===1){await db.prepare('DELETE FROM content_revision').run();await db.prepare("UPDATE live SET data=json_set(data,'$.title','After witness') WHERE item_id='site'").run();}
  return original(binding);
 });
 const response=await get(),body=await response.text();expect(response.status).toBe(200);expect(body).toContain('After witness');expect(body).not.toContain('Before witness');const after=await pair();expect(after[1]).toBe(before[1]);expect(after[0]).not.toBe(before[0]);
});
it('uses full independent facts when the final pair is missing',async()=>{
 await site();const original=revision.readRevision;let calls=0;vi.spyOn(revision,'readRevision').mockImplementation(async binding=>{if(++calls===1)await db.prepare('DELETE FROM content_revision').run();return original(binding);});
 const facts=vi.spyOn(read,'facts'),r=await get();expect(r.status).toBe(200);expect(facts).toHaveBeenCalledTimes(1);expect(await revision.readRevision(db)).toBeNull();
});
it('response reuse and credentials pay no witness, while no-validator ON keeps the original body proof',async()=>{
 await site();const tag=(await get()).headers.get('ETag')!;const initial=vi.spyOn(revision,'initialFacts').mockImplementation(async()=>{throw Error('out-of-scope initial witness');});const witness=vi.spyOn(revision,'readRevision').mockImplementation(async()=>{throw Error('out-of-scope witness');});
 expect((await get({},'GET',{...e,PUBLIC_ARTIFACTS:'1'})).status).toBe(200);
 for(const settings of [{...e,PUBLIC_RESPONSES:'1'},{...e,PUBLIC_ARTIFACTS:'1',PUBLIC_RESPONSES:'1'}]){expect((await get({'If-None-Match':tag},'GET',settings)).status).toBe(304);}
 for(const headers of ([{Authorization:''},{Cookie:'__Host-sk_owner=expired'},{Cookie:'__Host-sk_reader=invalid'}] as Record<string,string>[]))await get(headers);
 expect(witness).not.toHaveBeenCalled();expect(initial).not.toHaveBeenCalled();
});
it('rolls failed complete installation back and leaves concurrent legacy DML usable without a partial witness',async()=>{
 const defs=(env as unknown as {TEST_MIGRATIONS:{name:string;queries:string[]}[]}).TEST_MIGRATIONS.find(x=>x.name.includes('content_revision'))!.queries;
 expect(defs.length).toBe(32);const before=await pair();await db.batch(defs.map(sql=>db.prepare(sql)));expect(await pair()).toEqual(before);
 for(const {table} of fixture.tables)for(const suffix of ['ai','au','ad'])await db.prepare(`DROP TRIGGER content_revision__${table}__${suffix}`).run();await db.prepare('DROP TABLE content_revision').run();
 try{
  const failure=[...defs,"CREATE TABLE witness_fault (id INTEGER PRIMARY KEY)","INSERT INTO witness_fault VALUES(1)","INSERT INTO witness_fault VALUES(1)"];
  const results=await Promise.allSettled([db.batch(failure.map(sql=>db.prepare(sql))),db.prepare('INSERT INTO private_approvals(version) VALUES(7)').run()]);
  expect(results[0].status).toBe('rejected');expect(results[1].status).toBe('fulfilled');
  expect(await db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('content_revision','witness_fault')").first('n')).toBe(0);
  expect(await revision.readRevision(db)).toBeNull();expect(await db.prepare('SELECT count(*) n FROM private_approvals WHERE version=7').first('n')).toBe(1);
 }finally{await db.batch(defs.map(sql=>db.prepare(sql)));}
 expect(await revision.readRevision(db)).not.toBeNull();
});
it('rejects malformed, unavailable or multiple row snapshots without synthesizing a match',async()=>{
 const good={epoch:fixture.epoch_valid,epoch_storage:'text',n:'9007199254740993',storage:'integer'};
 for(const rows of [[],[good,good],[{...good,epoch:fixture.epoch_invalid[0]}],[{...good,n:'01'}],[{...good,storage:'text'}],[{...good,epoch_storage:'blob'}]]){
  const binding={prepare(sql:string){expect(sql).toBe(revision.REVISION_SQL);return {all:async()=>({results:rows})};}} as unknown as D1Database;
  expect(await revision.readRevision(binding)).toBeNull();
 }
 const binding={prepare(){throw Error('unavailable');}} as unknown as D1Database;expect(await revision.readRevision(binding)).toBeNull();
});
it('never replaces a late clock proof with an unchanged witness',async()=>{
 let item=await site();item=await content.updateItem(db,'assistant:test','site',item.version,{timezone:'UTC',notice:{text:'Boundary notice',until:'2030-01-01'}});await approvals.publishNow(db,[{id:item.id,version:item.version}],'',origin);
 let now=Date.parse('2030-01-01T23:59:30Z');vi.spyOn(Date,'now').mockImplementation(()=>now);const original=revision.readRevision;let calls=0;
 vi.spyOn(revision,'readRevision').mockImplementation(async binding=>{if(++calls===1)now+=60000;return original(binding);});
 const response=await get();expect(response.status).toBe(200);expect(await response.text()).not.toContain('Boundary notice');
});

it('strips only reserved metadata and retains exact owned dependency tuples and preimages',async()=>{
 await site();const plain=await read.facts(db,true),snapshot=await revision.initialFacts(db);
 expect(snapshot.facts).toEqual(plain);expect(snapshot.pair).toBe(await revision.readRevision(db));
 const rows=(await db.prepare(read.FACTS_SQL).all<read.Row>()).results,base=structuredClone(rows);
 const good={category:revision.WITNESS_CATEGORY,ident:'epoch-counter-v1',value:JSON.stringify([fixture.epoch_valid,'text','9007199254740993','integer'])};
 for(const metadata of [[],[good,good],[{...good,ident:'wrong'}],[{...good,value:'bad'}],[{...good,value:JSON.stringify([fixture.epoch_valid,'text','01','integer'])}]]){
  const result=revision.initialSnapshot([...rows,...metadata]);expect(result.pair).toBeNull();expect(result.facts).toEqual(plain);
 }
 expect(revision.initialSnapshot([...rows,good]).pair).toBe(JSON.stringify([fixture.epoch_valid,'9007199254740993']));expect(rows).toEqual(base);
 const duplicated=revision.initialSnapshot([...rows,rows[0],good]);expect(duplicated.facts.raw).toEqual([...rows,rows[0]].map(x=>[x.category,x.ident,x.value]));
 expect(plain.raw!.every(x=>x[0]!==revision.WITNESS_CATEGORY)).toBe(true);expect(read.viewProof(snapshot.facts)).toEqual(read.viewProof(plain));
});
it('falls back only on known missing optional table and propagates unrelated statement failures',async()=>{
 await site();const rows=(await db.prepare(read.FACTS_SQL).all<read.Row>()).results,calls:string[]=[];
 const binding={prepare(sql:string){calls.push(sql);return {all:async()=>{if(sql===revision.INITIAL_SQL)throw Error('D1_ERROR: no such table: content_revision: SQLITE_ERROR');return {results:rows};}};}} as unknown as D1Database;
 const result=await revision.initialFacts(binding);expect(result.pair).toBeNull();expect(result.facts).toEqual(await read.facts(db));expect(calls).toEqual([revision.INITIAL_SQL,read.FACTS_SQL]);
 const broken={prepare(){return {all:async()=>{throw Error('disk I/O error');}};}} as unknown as D1Database;
 await expect(revision.initialFacts(broken)).rejects.toThrow('disk I/O error');
});

it('bumps only actual items dependencies and preserves normal version fences and publication bumps',async()=>{
 const item=await site(),before=await pair();
 const original=db.batch.bind(db),counts:number[]=[];vi.spyOn(db,'batch').mockImplementation(async stmts=>{const results=await original(stmts);counts.push(results[0].meta.changes);return results;});
 const changed=await content.updateItem(db,'assistant:test','site',item.version,{title:'After ordinary edit'});
 expect(changed.version).toBe(item.version+1);expect(counts.at(-1)).toBe(1);
 const history=await db.prepare('SELECT data FROM revisions WHERE item_id=? AND version=?').bind('site',changed.version).first<{data:string}>();expect(JSON.parse(history!.data).title).toBe('After ordinary edit');
 const zero=await db.prepare('UPDATE items SET version=version+1 WHERE id=? AND version=?').bind('site',-1).run();expect(zero.meta.changes).toBe(0);expect((await pair())[0]).toBe(before[0]);
 let prior=await pair();await approvals.publishNow(db,[{id:changed.id,version:changed.version}],'',origin);expect(BigInt((await pair())[1])).toBeGreaterThan(BigInt(prior[1]));
 const entry=await content.createItem(db,'assistant:test','entry',{title:'Witness publication',date:'2026-10-18',body:'Public body'},undefined);await approvals.publishNow(db,[{id:entry.id,version:entry.version}],'',origin);
 prior=await pair();const removed=await content.removeItem(db,'assistant:test',entry.id,entry.version);await approvals.publishNow(db,[{id:removed.id,version:removed.version}],'',origin);expect(BigInt((await pair())[1])).toBeGreaterThan(BigInt(prior[1]));
 // Independent old-runtime SQL still advances for both actual Q_F inputs.
 prior=await pair();await db.prepare("UPDATE items SET created_at='2030-01-01' WHERE id='site'").run();expect(await pair()).toEqual([prior[0],String(BigInt(prior[1])+1n)]);
 prior=await pair();await db.prepare("UPDATE items SET id='renamed-site' WHERE id='site'").run();expect(await pair()).toEqual([prior[0],String(BigInt(prior[1])+1n)]);
});

it('ON conditional captures the shared snapshot, but a stale validator never supplies a body witness',async()=>{
 await site();const tag=(await get()).headers.get('ETag')!;
 const initial=vi.spyOn(revision,'initialFacts'),late=vi.spyOn(revision,'readRevision');
 const matching=await get({'If-None-Match':tag},'GET',{...e,PUBLIC_ARTIFACTS:'1'});
 expect(matching.status).toBe(304);expect(await matching.text()).toBe('');expect(initial).toHaveBeenCalledTimes(1);expect(late).toHaveBeenCalledTimes(1);
 initial.mockClear();late.mockClear();
 const stale=await get({'If-None-Match':'"stale"'},'GET',{...e,PUBLIC_ARTIFACTS:'1'});
 expect(stale.status).toBe(200);expect(await stale.text()).toContain('Before witness');expect(initial).toHaveBeenCalledTimes(1);expect(late).not.toHaveBeenCalled();
});
