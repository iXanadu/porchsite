import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observer, counters, settle } from './observer.mjs';
function backend(meta={rows_read:3,rows_written:1}) {
  const calls=[];
  const prepare=sql=>({ bind(...values){calls.push(['bind',sql,values]);return this;},async all(){calls.push(['all',sql]);return{results:[{category:'live',ident:'site',value:'[]'}],meta};},async run(){calls.push(['run',sql]);return{results:[],meta};} });
  return {calls,prepare,async batch(list){calls.push(['batch',list.length]);return list.map(()=>({results:[],meta}));}};
}
test('first/raw project one identical all query; batch records once per statement',async()=>{
  const raw=backend(),state=counters(),db=observer(raw,state);
  assert.equal(await db.prepare('first').bind('private fixture').first('ident'),'site');
  assert.deepEqual(await db.prepare('raw').raw({columnNames:true}),[['category','ident','value'],['live','site','[]']]);
  await db.batch([db.prepare('a').bind(1),db.prepare('b')]);
  assert.equal(state.rows_read,12);assert.equal(state.rows_written,4);assert.equal(state.statements,4);
  assert.deepEqual(raw.calls,[['bind','first',['private fixture']],['all','first'],['all','raw'],['bind','a',[1]],['batch',2]]);
  assert(!JSON.stringify(state).includes('private fixture'));
});
test('missing metadata, swallowed failures, raw unknown columns and late work refuse',async()=>{
  for(const meta of [{},{rows_read:0,rows_written:-1},{rows_read:1.2,rows_written:0}]) {
    const state=counters();await assert.rejects(observer(backend(meta),state).prepare('query').all());assert(state.failed);
  }
  const state=counters(),db=observer(backend(),state);state.closed=true;
  await assert.rejects(db.prepare('query').first());assert(state.failed);
  const empty={prepare(){return{async all(){return{results:[],meta:{rows_read:0,rows_written:0}};}};}};
  await assert.rejects(observer(empty,counters()).prepare('empty').raw({columnNames:true}),/header/);
});
test('nested waitUntil work is included and rejection cannot be silently omitted',async()=>{
  const pending=[],seen=[];
  pending.push(Promise.resolve().then(()=>{seen.push('first');pending.push(Promise.resolve().then(()=>seen.push('nested')));}));
  await settle(pending);assert.deepEqual(seen,['first','nested']);
  await assert.rejects(settle([Promise.reject(Error('deferred failure'))]),/deferred failure/);
});
