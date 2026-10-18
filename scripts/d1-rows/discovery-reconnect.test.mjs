import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
test('a description-only discovery change requires reconnect, without renaming a tool',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'porchsite-discovery-'));
 try{
  const run=(command,args,cwd=dir)=>{const result=spawnSync(command,args,{cwd,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  run('git',['init','-q']);run('git',['config','user.name','Fixture']);run('git',['config','user.email','fixture@example.com']);
  for(const folder of ['cloudflare/src','cloudflare/migrations','server/tests/app'])fs.mkdirSync(path.join(dir,folder),{recursive:true});
  fs.writeFileSync(path.join(dir,'cloudflare/src/mcp.ts'),'server.registerTool("theme_list", definition);\n');
  const contract=path.join(dir,'server/tests/app/cloudflare_tools.json');
  fs.writeFileSync(contract,JSON.stringify({tools:[{name:'theme_list',description:'Before'}]}));
  run('git',['add','cloudflare/src/mcp.ts','server/tests/app/cloudflare_tools.json']);
  run('git',['commit','-qm','Discovery fixture\n\nCo-Authored-By: Codex gpt-6 <noreply@openai.com>']);
  const hash=run('git',['rev-parse','--short','HEAD']);
  const previous={release:'2026.10.17-'+hash,date:'2026-10-17',security:false,reconnect:false,migrations:[],changes:['Before.']};
  const current={...previous,release:'2026.10.18-abcdef0',date:'2026-10-18',changes:['After.']};
  const archive=path.join(dir,'cloudflare/downloads/releases',previous.release);fs.mkdirSync(path.join(archive,'migrations'),{recursive:true});fs.writeFileSync(path.join(archive,'sitekeeper.js'),'fixture');
  const file=path.join(dir,'changelog.json');
  const check=()=>{fs.writeFileSync(file,JSON.stringify({releases:[current,previous]}));return spawnSync(process.execPath,[path.join(root,'cloudflare/scripts/changelog.mjs'),'check',file,current.release],{cwd:path.join(dir,'cloudflare'),encoding:'utf8'});};
  assert.equal(check().status,0);
  fs.writeFileSync(contract,JSON.stringify({tools:[{name:'theme_list',description:'After'}]}));
  const refused=check();assert.equal(refused.status,1);assert.match(refused.stderr,/discovery changed.*reconnect/s);
  current.reconnect=true;assert.equal(check().status,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
