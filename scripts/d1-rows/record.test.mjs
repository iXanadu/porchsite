import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacity, compare, printComparison, validate } from './record.mjs';
const make = () => {
  const sites = Array.from({length:13}, (_,i) => 'site-' + i), cells = {};
  for (const site of sites) for (const mode of ['off','on']) for (const name of ['cold','plain','not_modified']) cells[`${site}/${mode}/${name}`] = { rows_read:10, rows_written:0 };
  return { format:1, inputs_sha256:'a'.repeat(64), source_sha256:'b'.repeat(64), artifact_sha256:'c'.repeat(64), sites, cells };
};
test('each read or write increase refuses without a visible justification', () => {
  for (const metric of ['rows_read','rows_written']) for (const key of Object.keys(make().cells)) {
    const before=make(), after=make();after.cells[key][metric]++;
    assert.throws(() => compare(after,before), /rows_justification required/);
    const reason='One extra indexed write bounds a repeated-visitor flood.';
    assert.equal(compare(after,before,reason).length,1);
    const output=[];printComparison(after,before,reason,line=>output.push(line));
    assert(output.some(line=>line.includes(reason)));
    assert(output.some(line=>line.includes(key)));
  }
});
test('waiver never covers corrupt or mismatched records', () => {
  for (const mutate of [r=>delete r.cells[Object.keys(r.cells)[0]],r=>r.cells.extra={rows_read:1,rows_written:0},r=>r.cells[Object.keys(r.cells)[0]].rows_written=-1,r=>r.inputs_sha256='d'.repeat(64)]) {
    const before=make(),after=make();mutate(after);assert.throws(()=>compare(after,before,'Reviewed reason'));
  }
  for (const reason of ['', ' ', 1, 'line\nbreak','x'.repeat(1001)]) assert.throws(()=>compare(make(),make(),reason));
});
test('zero and read/write constrained account arithmetic', () => {
  assert.deepEqual(capacity({rows_read:0,rows_written:0}),{reads:null,writes:null,combined:null});
  assert.deepEqual(capacity({rows_read:100,rows_written:4}),{reads:50000,writes:25000,combined:25000});
  assert.deepEqual(capacity({rows_read:200,rows_written:0}),{reads:25000,writes:null,combined:25000});
  assert.deepEqual(compare(validate(make()),make()),[]);
});

test('expanded operation cells cannot disappear or hide read/write increases', async()=>{
 const {OPERATIONS,WRITE_MANIFEST}=await import('./write-fixtures.mjs');
 const expanded=()=>{const r=make();r.format=2;r.operations=structuredClone(WRITE_MANIFEST);r.instrumentation={product_sha256:r.artifact_sha256,derived_sha256:'d'.repeat(64),adapter_sha256:'e'.repeat(64),scope_sha256:'f'.repeat(64),mapping:[{start:1,end:19,from:'cloudflare:workers',to:'./native-workers.mjs'}]};for(const mode of ['off','on'])for(const operation of OPERATIONS)r.cells[`operations/${mode}/${operation}`]={rows_read:8,rows_written:4};return r;};
 for(const mode of ['off','on'])for(const operation of OPERATIONS)for(const metric of ['rows_read','rows_written']){
  const before=expanded(),after=expanded(),key=`operations/${mode}/${operation}`;after.cells[key][metric]++;
  assert.throws(()=>compare(after,before),/rows_justification required/);assert.equal(compare(after,before,'Recorded cost increase').length,1);
 }
 for(const change of [r=>delete r.cells['operations/off/collect/at_cap'],r=>r.operations.expected_cap=false,r=>r.cells['operations/on/import/file'].rows_written=NaN]){const r=expanded();change(r);assert.throws(()=>validate(r));}
 assert.throws(()=>compare(expanded(),make(),'Format changes need a real rebase'));
 const output=[];printComparison(expanded(),expanded(),undefined,x=>output.push(x));assert(output.some(x=>x.includes('beacon events a day')));assert(output.some(x=>x.includes('approvals a day')));assert(output.some(x=>x.includes('imported files a day')));
});
