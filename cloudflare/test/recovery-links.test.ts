import {env} from 'cloudflare:workers';
import {beforeEach,expect,it} from 'vitest';
import type {Env} from '../src/env';
import {handle,recoveryQueryRefusal} from '../src/routes';
import * as owner from '../src/owner';
import fixture from '../../spec/fixtures/recovery-links.json';
const e=env as unknown as Env,db=e.DB,origin='https://site.example';
const at=(path:string,init:RequestInit={})=>handle(new Request(origin+path,init),e);
beforeEach(async()=>{for(const t of ['recovery_codes','challenges','passkeys','sessions','owner'])await db.prepare(`DELETE FROM ${t}`).run();await db.prepare("INSERT INTO owner(id,name,user_handle,created_at) VALUES(1,'Owner','AAAAAAAAAAAAAAAAAAAAAA','2026-10-18')").run();});
it('keeps fragment credentials out of HTML and uses only paired DOM fill and explicit POST',async()=>{
 const code='credential-canary-\"><script>';
 for(const suffix of ['#code='+encodeURIComponent(code),'']){
  const r=await at('/recover'+suffix),text=await r.text();expect(r.status).toBe(200);expect(text).not.toContain(code);expect(text).not.toContain('value="credential');expect(text).toContain(fixture.script);expect(text).toContain('<form method="post" action="/recover/options">');expect(text.indexOf('history.replaceState')).toBeLessThan(text.indexOf('await fetch('));expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');expect(r.headers.get('Cache-Control')).toBe('no-store');
 }
 const head=await at('/recover?code=canary',{method:'HEAD'});expect(head.status).toBe(400);expect(await head.text()).toBe('');
});
it('accepts recovery credentials only from JSON or form bodies and keeps canonical hash storage',async()=>{
 const code='recovery-code-with-24-random-bytes-test';await owner.issueRecoveryCode(db,code);
 const h=await db.prepare('SELECT code_hash FROM recovery_codes').first<string>('code_hash');expect(h).toHaveLength(43);expect(h).not.toBe(code);
 for(const headersBody of [{headers:{'Content-Type':'application/json'},body:JSON.stringify({code})},{headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:new URLSearchParams({code}).toString()}]){
  const r=await at('/recover/options',{method:'POST',...headersBody});expect(r.status,await r.clone().text()).toBe(200);expect(await r.text()).not.toContain(code);
 }
 const r=await at('/recover/options?code='+code,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});expect(r.status).toBe(400);expect((await r.clone().json() as any).error).toBe('code_in_url');expect(await r.text()).not.toContain(code);expect(await db.prepare('SELECT count(*) n FROM recovery_codes').first('n')).toBe(1);
});
it('does not echo malformed JSON or nonobject JSON from recovery options or verification',async()=>{
 for(const path of ['/recover/options','/recover/verify'])for(const body of ['{"code":"private-canary', 'null','[]']){
  const r=await at(path,{method:'POST',headers:{'Content-Type':'application/json'},body});expect(r.status).toBe(path === '/recover/options' ? 403 : 400);const text=await r.text();expect(text).not.toContain('private-canary');expect(JSON.parse(text).error).toBe(path === '/recover/options' ? 'bad_code' : 'expired');expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');expect(r.headers.get('Cache-Control')).toBe('no-store');
 }
});
it('has a tested independent cutoff with exact credential-free GET and HEAD refusals',async()=>{
 for(const query of fixture.query_cases)for(const method of ['GET','HEAD']){
  const req=new Request(origin+'/recover'+query,{method});expect(recoveryQueryRefusal(req,true)).toBeNull();const r=recoveryQueryRefusal(req,false)!;expect(r.status).toBe(400);expect(r.headers.get('Cache-Control')).toBe('no-store');expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');expect(r.headers.has('Location')).toBe(false);if(method==='HEAD')expect(await r.text()).toBe('');else expect(await r.json()).toEqual({error:'code_in_url',message:fixture.cutoff_message});
 }
 expect(recoveryQueryRefusal(new Request(origin+'/recover#code=canary'),false)).toBeNull();
});
it('keeps recovery unavailable before claim without reflecting query values',async()=>{
 await db.prepare('DELETE FROM owner').run();for(const method of ['GET','HEAD']){const r=await at('/recover?code=unclaimed-canary',{method});expect(r.status).toBe(409);expect(await r.text()).not.toContain('unclaimed-canary');}
});
it('refuses decoded query credentials on exactly the accepted recovery routes without changing stored authority',async()=>{
 const code='body-credential-canary';await owner.issueRecoveryCode(db,code);
 const before=await db.prepare('SELECT * FROM recovery_codes').all();
 for(const query of fixture.query_cases)for(const [path,method] of [['/recover','GET'],['/recover','HEAD'],['/recover/options','POST'],['/recover/verify','POST']]){
  const r=await at(path+query,{method,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({code,response:'body-canary'})}:{})});
  expect(r.status).toBe(400);expect(r.headers.get('Cache-Control')).toBe('no-store');expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');expect(r.headers.has('Location')).toBe(false);
  if(method==='HEAD')expect(await r.text()).toBe('');else expect(await r.json()).toEqual({error:'code_in_url',message:fixture.cutoff_message});
 }
 expect((await db.prepare('SELECT * FROM recovery_codes').all()).results).toEqual(before.results);
 expect(await db.prepare('SELECT count(*) n FROM challenges').first('n')).toBe(0);
 for(const [path,method] of [['/recover-extra','GET'],['/recover/','GET'],['/recover/options','GET'],['/recover/verify','HEAD'],['/recover','POST'],['/recover/options','OPTIONS']]){
  const plain=await at(path,{method}),query=await at(path+'?code=canary',{method});
  expect(query.status).toBe(plain.status);expect(await query.text()).toBe(await plain.text());
 }
 await db.prepare('DELETE FROM owner').run();
 for(const path of ['/recover/options','/recover/verify']){const r=await at(path+'?%63ode=canary',{method:'POST',body:'not-json'});expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'unclaimed',message:'This site has no owner yet.'});}
});
