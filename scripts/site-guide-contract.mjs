#!/usr/bin/env node
// One serializer generates the revision consumed by both editions.
import {build} from '../cloudflare/node_modules/esbuild/lib/main.js';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const target=join(root,'server/server/app/site-state-guide.json');
const temp=mkdtempSync(join(tmpdir(),'site-guide-'));
export function ordered(value){
 if(Array.isArray(value))return value.map(ordered);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])]));
 return value;
}
try{
 await build({entryPoints:[join(root,'cloudflare/src/site-guide.ts')],outfile:join(temp,'guide.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'error'});
 const {fixedGuide}=await import(pathToFileURL(join(temp,'guide.mjs')));
 const payload=JSON.stringify(ordered({format:1,guide:fixedGuide()}));
 const revision='ssg1-sha256-'+createHash('sha256').update(payload).digest('hex');
 const output=JSON.stringify({revision},null,2)+'\n';
 if(process.argv.includes('--write'))writeFileSync(target,output);
 else if(readFileSync(target,'utf8')!==output)throw Error('site guide revision is stale; run node scripts/site-guide-contract.mjs --write');
 if(process.argv.includes('--input'))process.stdout.write(payload+'\n');
 else console.log('site-guide contract: '+revision);
}finally{rmSync(temp,{recursive:true,force:true});}
