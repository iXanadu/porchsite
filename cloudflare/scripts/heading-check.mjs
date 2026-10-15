// Host-clock regression: Worker test clocks may be frozen outside a request.
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import test from 'node:test';
import {transformSync} from 'esbuild';
const source=readFileSync(new URL('../src/html.ts',import.meta.url),'utf8');
const {code}=transformSync(source,{loader:'ts',format:'esm'});
const {markdown}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('ASCII heading fixtures and repeated suffix allocation use a real host clock',()=>{
 const cases=JSON.parse(readFileSync(new URL('../../spec/heading-id-cases.json',import.meta.url),'utf8'));
 for(const c of cases)assert.deepEqual(Array.from(markdown(c.source,undefined,true).html.matchAll(/ id="([^"]+)"/g),m=>m[1]),c.ids);
 markdown('# a\n'.repeat(100),undefined,true);
 const times=[];
 for(const n of [1000,2000,4000]){
  const samples=[];
  for(let run=0;run<3;run++){
   const start=performance.now(),html=markdown('# a\n'.repeat(n),undefined,true).html;
   samples.push(performance.now()-start);assert(html.includes(`id="a-${n}"`));
  }
  times.push(samples.sort((a,b)=>a-b)[1]);
 }
 console.log(JSON.stringify({repeatedHeadings:[1000,2000,4000],medianParserMs:times,clock:'node:perf_hooks'}));
 assert(times[2]<150,'4000 headings exceed the parser regression budget');
 assert(times[2]<Math.max(1,times[0])*8,'four times the input must not need quadratic work');
});
