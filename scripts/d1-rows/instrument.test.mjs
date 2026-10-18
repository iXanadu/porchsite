import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {instrument} from './instrument.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
test('measurement mapping preserves original artifact and only changes parsed static imports',async()=>{
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'row-adapter-'));try{
  const original='import {env,waitUntil as wait} from "cloudflare:workers";\nconst text="cloudflare:workers";export default env;';
  fs.writeFileSync(path.join(out,'application.js'),original);const proof=await instrument(root,out);
  assert.equal(fs.readFileSync(path.join(out,'application.js'),'utf8'),original);assert.equal(proof.mapping.length,1);
  assert.equal(fs.readFileSync(path.join(out,'application-measured.js'),'utf8'),original.replace('from "cloudflare:workers"','from "./native-workers.mjs"'));
  fs.writeFileSync(path.join(out,'application.js'),'const value=import("cloudflare:workers");');await assert.rejects(instrument(root,out),/dynamic/);
 }finally{fs.rmSync(out,{recursive:true,force:true});}
});
