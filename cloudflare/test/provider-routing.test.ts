import {env} from 'cloudflare:workers';
import {afterEach,expect,it,vi} from 'vitest';
import {OAuthProvider} from '@cloudflare/workers-oauth-provider';
import worker from '../src/index';
import type {Env} from '../src/env';
import {handle} from '../src/routes';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as mcpAuth from '../src/mcp-auth';
const origin='https://site.example',e={...env,PUBLIC_ARTIFACTS:''} as unknown as Env;
const context=()=>({waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext);
afterEach(()=>vi.restoreAllMocks());
it('public routes retain direct gated-handler bytes without invoking OAuthProvider',async()=>{
 const site=await content.createItem(e.DB,'owner','site',{title:'Public fixture',archive:{enabled:true}},undefined);
 const entry=await content.createItem(e.DB,'owner','entry',{title:'Entry fixture',body:'Published body',date:'2026-10-18'},undefined);
 await approvals.publishNow(e.DB,[{id:site.id,version:1},{id:entry.id,version:1}],'',origin);
 const provider=vi.spyOn(OAuthProvider.prototype,'fetch').mockRejectedValue(new Error('public route reached provider'));
 const bearer=vi.spyOn(mcpAuth,'mcpBearer');
 for(const path of ['/','/index.md','/archive/','/archive/index.md','/feed.xml','/sitemap.xml','/llms.txt','/robots.txt','/media/00000000000000000000000000000000.png','/missing/','/oauth/token/','/mcp-lookalike']){
  for(const method of ['GET','HEAD']){
   const req=new Request(origin+path,{method}),direct=await handle(req,e,context()),actual=await worker.fetch(req,{...e,SITE_URL:origin},context());
   expect(actual.status,path+method).toBe(direct.status);
   expect(await actual.text(),path+method).toBe(await direct.text());
   const headers=new Headers(actual.headers);headers.delete('X-Porchsite-Release');
   expect([...headers],path+method).toEqual([...direct.headers]);
  }
 }
 expect(provider).not.toHaveBeenCalled();expect(bearer).not.toHaveBeenCalled();
 const next=await content.updateItem(e.DB,'owner','site',1,{private:true});
 await approvals.publishNow(e.DB,[{id:site.id,version:next.version}],'',origin);
 for(const path of ['/','/index.md','/feed.xml','/sitemap.xml','/media/00000000000000000000000000000000.png']){
  const req=new Request(origin+path,{headers:{Authorization:'Bearer invalid'}}),direct=await handle(req,e,context()),actual=await worker.fetch(req,{...e,SITE_URL:origin},context());
  expect(actual.status).toBe(direct.status);expect(await actual.text()).toBe(await direct.text());expect(actual.headers.get('Cache-Control')).toBe(direct.headers.get('Cache-Control'));
 }
 expect(provider).not.toHaveBeenCalled();expect(bearer).not.toHaveBeenCalled();
});
it('OAuth namespaces, MCP descendants, consent and owner-review retain provider routing',async()=>{
 const provider=vi.spyOn(OAuthProvider.prototype,'fetch').mockImplementation(async()=>new Response('provider',{headers:{'X-Provider':'kept'}}));
 for(const path of ['/mcp','/mcp/','/mcp/nested','/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource/other','/oauth/token','/oauth/register','/authorize','/review','/review/assistants','/review/assistants/nested']){
  provider.mockClear();const response=await worker.fetch(new Request(origin+path,{headers:{Authorization:'Bearer unknown-oauth'}}),{...e,SITE_URL:origin},context());
  expect(provider,path).toHaveBeenCalledTimes(1);expect(response.headers.get('X-Provider')).toBe('kept');expect(await response.text()).toBe('provider');
 }
});
