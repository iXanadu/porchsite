import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inputs,verify,itemsDependencies} from './check-witness-compat.mjs';
const current=inputs(),contract=JSON.parse(readFileSync(new URL('../spec/fixtures/witness-compat.json',import.meta.url),'utf8'));
const check=(input=current.input,server=current.serverRelation,template=current.template)=>verify(input,contract,server,template);
test('accepts the fixed checked SQL, batch construction and dependency inventory',()=>assert.equal(check(),true));
test('refuses a new strict metadata check on live or media writes',()=>{
 for(const table of ['live','media']){
  const input={...current.input,'new-mutation.ts':`export async function changed(db:any){const r=await db.prepare("UPDATE ${table} SET name=name").run();if(r.meta.changes!==1)throw Error('lost');}`};
  assert.throws(()=>check(input),/Unreviewed/);
 }
});
test('refuses new aliases, destructuring and computed mutation metadata checks',()=>{
 for(const expression of ["const {changes:n}=r.meta;if(n!==1)throw Error('lost');","const n=r['meta']['changes'];if(n===1)return true;","const n=r['me'+'ta']['cha'+'nges'];if(n!==1)throw Error('lost');","const n=r[dynamic];if(n===1)return true;"]){
  assert.throws(()=>check({...current.input,'new-mutation.ts':`export function changed(r:any,dynamic:any){${expression}}`}),/Unreviewed/);
 }
});
test('refuses a changed checked UPDATE or batch slot without changing the count guard',()=>{
 const old=current.input['content.ts'];
 for(const text of [old.replace('UPDATE items SET data = ?, slug = ?', 'UPDATE items SET created_at = ?, slug = ?'),old.replace('results[0].meta.changes !== 1','results[1].meta.changes !== 1'),old.replace('results[0].meta.changes !== 1','results[0].meta.changes < 1')]){
  assert.notEqual(text,old);assert.throws(()=>check({...current.input,'content.ts':text}),/Unreviewed/);
 }
});
test('parses the exact items join and projection and refuses added dependencies',()=>{
 const relation=current.input['public-read.ts'].match(/export const FACTS_RELATION=(`[^]*?`);\nexport const FACTS_SQL=/)[1];
 assert.deepEqual(itemsDependencies(relation),['id','created_at']);
 assert.deepEqual(itemsDependencies(current.serverRelation),['id','created_at']);
 for(const extra of ['slug','deleted','data','version']){
  const changed=relation.replace('i.created_at','i.created_at,i.'+extra);
  assert.throws(()=>itemsDependencies(changed),/Unreviewed Q_F/);
  assert.throws(()=>check({...current.input,'public-read.ts':current.input['public-read.ts'].replace('i.created_at','i.created_at,i.'+extra)}),/Unreviewed/);
 }
 assert.throws(()=>itemsDependencies(relation.replace('i.id=l.item_id','i.slug=l.item_id')),/Unreviewed/);
});
test('refuses any widening of the exact null-safe predicate template',()=>{
 assert.throws(()=>check(current.input,current.serverRelation,current.template.replace('NEW.created_at IS NOT OLD.created_at','NEW.version IS NOT OLD.version')),/Unreviewed trigger/);
 assert.throws(()=>check(current.input,current.serverRelation,current.template.replace('NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at','1')),/Unreviewed trigger/);
});

test('refuses obfuscated metadata keys and an aliased expected value in new or existing modules',()=>{
 const unsafe="const mk=['m','eta'].join('');const ck=['chan','ges'].join('');const expected=Number(true);export async function unsafe(db:any){const r=await db.prepare('UPDATE live SET version=version+1').run();if(r[mk][ck]!==expected)throw Error('conflict');}";
 assert.throws(()=>check({...current.input,'unsafe.ts':unsafe}),/Unreviewed runtime module/);
 assert.throws(()=>check({...current.input,'content.ts':current.input['content.ts']+'\n'+unsafe}),/Unreviewed runtime module/);
 const removed={...current.input};delete removed['content.ts'];assert.throws(()=>check(removed),/Unreviewed runtime module/);
});
