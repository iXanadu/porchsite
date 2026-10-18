import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {hash} from './fixtures.mjs';
export async function instrument(root,out){
 const require=createRequire(path.join(root,'cloudflare/package.json'));
 const {init,parse}=require('es-module-lexer');await init;
 const original=fs.readFileSync(path.join(out,'application.js'),'utf8');
 const [imports]=parse(original);const mappings=[];
 for(const item of imports)if(item.n==='cloudflare:workers'){
  assert.equal(item.d,-1,'dynamic native-module import cannot be instrumented');assert.equal(original.slice(item.s,item.e),item.n);mappings.push({start:item.s,end:item.e,from:item.n,to:'./native-workers.mjs'});
 }
 assert(mappings.length>0,'native-module import inventory missing');
 let derived=original;for(const item of [...mappings].reverse())derived=derived.slice(0,item.start)+item.to+derived.slice(item.end);
 const [after]=parse(derived);assert(!after.some(x=>x.n==='cloudflare:workers'),'native-module import escaped adapter');
 fs.writeFileSync(path.join(out,'application-measured.js'),derived);
 for(const name of ['native-workers.mjs','wait-scope.mjs'])fs.copyFileSync(path.join(root,'scripts/d1-rows',name),path.join(out,name));
 const provenance={product_sha256:hash(original),derived_sha256:hash(derived),adapter_sha256:hash(fs.readFileSync(path.join(out,'native-workers.mjs'))),scope_sha256:hash(fs.readFileSync(path.join(out,'wait-scope.mjs'))),mapping:mappings};
 fs.writeFileSync(path.join(out,'instrumentation.json'),JSON.stringify(provenance,null,2));return provenance;
}
