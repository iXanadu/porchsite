import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runScoped,registerContext,forwardNative} from './wait-scope.mjs';
test('native forwarding retains identical promise even when native throws',async()=>{
 let done=false;const original=Promise.resolve().then(()=>{done=true;});
 const result=await runScoped(async()=>{assert.throws(()=>forwardNative(p=>{assert.equal(p,original);throw Error('native');},original),/native/);return 7;});
 assert.equal(result.value,7);assert.equal(result.nativeRegistrations,1);assert(done);
});
test('nested module/context tasks settle before closing the same scope',async()=>{
 const order=[];const result=await runScoped(async()=>{
  registerContext(Promise.resolve().then(()=>{order.push('ctx');forwardNative(()=>{},Promise.resolve().then(()=>{order.push('module');registerContext(Promise.resolve().then(()=>order.push('nested')));}));}));
 });assert.deepEqual(order,['ctx','module','nested']);assert.equal(result.nativeRegistrations,1);
 await assert.rejects(runScoped(async()=>registerContext(Promise.reject(Error('work')))),/work/);
 assert.throws(()=>forwardNative(()=>{},Promise.resolve()),/outside/);
});
test('scopes isolate, concurrency and late registrations refuse',async()=>{
 let late;await runScoped(async()=>{late=()=>registerContext(Promise.resolve());await assert.rejects(runScoped(async()=>{}),/Concurrent/);});
 assert.throws(late,/outside/);const next=await runScoped(async()=>{});assert.equal(next.nativeRegistrations,0);
});
