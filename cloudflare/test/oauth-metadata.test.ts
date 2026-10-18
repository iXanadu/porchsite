import {env} from 'cloudflare:workers';
import {beforeEach,expect,it,vi} from 'vitest';
import worker from '../src/index';
import type {Env} from '../src/env';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import fixture from '../../spec/fixtures/oauth-metadata-path.json';
import cors from '../../spec/fixtures/oauth-cors.json';
const origin='https://site.example';
const ctx=()=>({waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext);
beforeEach(async()=>{
 const db=(env as unknown as Env).DB;
 const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{name:string}>();
 for(const {name} of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare("INSERT INTO auth_state(id) VALUES(1)").run();
});
for(const privateMode of [false,true]) it(`oauth_metadata_path: protocol-only on ${privateMode?'private':'public'} sites`,async()=>{
 const e={...env,SITE_URL:origin} as unknown as Env;
 await e.DB.prepare("INSERT INTO owner(id,name,user_handle,created_at) VALUES(1,'Owner','AA','2026-10-18')").run();
 const site=await content.createItem(e.DB,'owner','site',{title:'Hidden metadata fixture',private:privateMode},undefined);
 await approvals.publishNow(e.DB,[{id:site.id,version:site.version}],'',origin);
 expect((await worker.fetch(new Request(origin+'/'),e,ctx())).status).toBe(privateMode?404:200);
 const noStorage=new Proxy({}, {get(){throw new Error('metadata touched storage');}});
 const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('metadata performed external fetch'));
 try {
  for(const row of fixture.cases) for(const caller of fixture.origins) for(const credential of fixture.credentials){
   const headers=new Headers();for(const [key,value] of Object.entries(credential))if(value!==undefined)headers.set(key,value);headers.set('If-None-Match','*');if(caller!==null)headers.set('Origin',caller);
   const response=await worker.fetch(new Request(origin+row.path,{method:row.method,headers}),{...e,DB:noStorage,OAUTH_KV:noStorage} as unknown as Env,ctx());
   expect(response.status).toBe(row.status);
   expect(Object.fromEntries([...response.headers].filter(([k])=>k.startsWith('access-control-')))).toEqual(Object.fromEntries(Object.entries(cors.headers).map(([k,v])=>[k.toLowerCase(),v])));
   for(const name of ['Location','WWW-Authenticate','Set-Cookie','ETag'])expect(response.headers.has(name),name).toBe(false);
   const body=await response.text();
   if(row.status===404||row.method!=='GET')expect(body).toBe('');
   else expect(JSON.parse(body).resource).toBe(origin+'/mcp');
   if(row.status===204)expect(response.headers.has('Content-Length')).toBe(false);
  }
  expect(fetch).not.toHaveBeenCalled();
 } finally {fetch.mockRestore();}
});
