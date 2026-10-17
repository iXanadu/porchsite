import {env} from 'cloudflare:workers';
import {it,expect,vi,afterEach} from 'vitest';
import worker from '../src/index';
import type {Env} from '../src/env';
const e=env as unknown as Env;
const ctx={waitUntil(){throw Error('redirect must not prepare content');},passThroughOnException(){}} as unknown as ExecutionContext;
afterEach(()=>vi.restoreAllMocks());
it('bl_http redirects every method/path before any database or OAuth work',async()=>{
 const prepare=vi.spyOn(e.DB,'prepare');
 for(const host of ['site.example','www.site.example','192.0.2.1','localhost.example'])for(const path of ['/','/robots.txt','/wp-admin/install.php','/mcp?x=%2F&y=a+b'])for(const method of ['GET','HEAD','POST']){
  const response=await worker.fetch(new Request('http://'+host+path,{method,headers:{Authorization:'Bearer invalid'},...(method==='POST'?{body:'not-json'}:{})}),e,ctx);
  expect(response.status).toBe(301);expect(response.headers.get('Location')).toBe('https://'+host+path);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(await response.text()).toBe('');
 }
 expect(prepare).not.toHaveBeenCalled();
});
it('bl_http preserves HTTPS and loopback HTTP OAuth metadata',async()=>{
 for(const origin of ['https://site.example','http://localhost:8787','http://127.0.0.1:8787','http://127.42.0.7:8787','http://[::1]:8787']){
  const response=await worker.fetch(new Request(origin+'/.well-known/oauth-protected-resource/mcp'),e,ctx);
  expect(response.status).toBe(200);expect(response.headers.has('Location')).toBe(false);expect((await response.json() as any).resource).toBe(origin+'/mcp');
 }
});
