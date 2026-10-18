import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

test('hosting recovery issuer stores only a hash after checking claim and replacing the prior code', async () => {
 const before={argv:process.argv,fetch:globalThis.fetch,account:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,out:process.stdout.write,err:process.stderr.write};
 const calls=[], output=[];
 try {
  process.argv=['node','recovery-link.mjs','--database','fixture-database','--origin','https://example.com'];
  process.env.CLOUDFLARE_ACCOUNT_ID='fixture-account';process.env.CLOUDFLARE_API_TOKEN='fixture-token';
  process.stdout.write=chunk=>{output.push(String(chunk));return true;};process.stderr.write=()=>true;
  globalThis.fetch=async(url,options)=>{
   assert.equal(new URL(url).hostname,'api.cloudflare.com');
   const body=JSON.parse(options.body);calls.push(body);
   return new Response(JSON.stringify({success:true,result:[{success:true,results:calls.length===1?[{owner:1}]:[]}]}),{headers:{'Content-Type':'application/json'}});
  };
  await import('./recovery-link.mjs');
  assert.equal(calls.length,3);
  assert.equal(calls[0].sql,'SELECT 1 FROM owner WHERE id = 1');
  assert.equal(calls[1].sql,'DELETE FROM recovery_codes');
  const link=new URL(output.join('').trim()),code=new URLSearchParams(link.hash.slice(1)).get('code');
  assert.equal(link.pathname,'/recover');assert.equal(link.search,'');assert.equal(Buffer.from(code,'base64url').length,24);
  assert.equal(calls[2].params[0],createHash('sha256').update(code).digest('base64url'));
  assert.ok(!JSON.stringify(calls).includes(code));
  assert.ok(Date.parse(calls[2].params[2])>Date.now()+23*3600000);
 } finally {
  process.argv=before.argv;globalThis.fetch=before.fetch;process.stdout.write=before.out;process.stderr.write=before.err;
  if(before.account===undefined)delete process.env.CLOUDFLARE_ACCOUNT_ID;else process.env.CLOUDFLARE_ACCOUNT_ID=before.account;
  if(before.token===undefined)delete process.env.CLOUDFLARE_API_TOKEN;else process.env.CLOUDFLARE_API_TOKEN=before.token;
 }
});

import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const fixture=JSON.parse(readFileSync(new URL('../../spec/fixtures/recovery-links.json',import.meta.url),'utf8'));
for(const item of fixture.fill_cases)test('recovery DOM transport '+JSON.stringify(item),()=>{
 const events=[];let value;
 const input={set value(v){assert.deepEqual(events,['clear']);value=v;},set innerHTML(v){throw Error('HTML assignment');}};
 vm.runInNewContext(fixture.script,{URLSearchParams,location:{search:item.search,hash:item.hash,pathname:'/recover'},history:{replaceState(state,title,path){assert.equal(path,'/recover');events.push('clear');}},document:{querySelector(selector){assert.equal(selector,'input[name="code"]');return input;}}});
 assert.equal(value,item.value);assert.deepEqual(events,['clear']);
});
