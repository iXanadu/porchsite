import {env} from 'cloudflare:workers';
import {beforeEach,expect,it} from 'vitest';
import worker from '../src/index';
import {dailyDatabase,dailyRequest,dailyTool,dailyOwnerAuthorized,optionalD1,VISITOR_LIMIT,OWNER_LIMIT} from '../src/daily-limit';
import * as keys from '../src/keys';
import * as readKeys from '../src/read-keys';
import type {Env} from '../src/env';
const e=env as unknown as Env,db=e.DB,origin='https://site.example';
const context={waitUntil(work:Promise<unknown>){void work.catch(()=>{});},passThroughOnException(){}} as unknown as ExecutionContext;
const provider=(kind='read')=>new Error(`D1_ERROR: Your account has exceeded D1's free tier daily row ${kind} limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.`);
function fake(error:Error){
 let calls=0;
 const statement={bind(){return statement;},async all(){calls++;throw error;},async first(){calls++;throw error;},async raw(){calls++;throw error;},async run(){calls++;throw error;}};
 const database={prepare(){return statement;},async batch(){calls++;throw error;},async exec(){calls++;throw error;}} as unknown as D1Database;
 return {database,calls:()=>calls};
}
it.each(['read','write'])('required native %s error survives swallowed foreground failure without replay',async kind=>{
 for(const method of ['all','first','raw','run','batch','exec']){
  const native=fake(provider(kind));
  const response=await dailyRequest(new Request(origin+'/secret?code=never-echo'),native.database,async wrapped=>{
   const operation=()=>method==='batch'?wrapped.batch([wrapped.prepare('SELECT 1')]):method==='exec'?wrapped.exec('SELECT 1'):(wrapped.prepare('SELECT 1') as any)[method]();
   await operation().catch(()=>{});await operation().catch(()=>{});
   return new Response('private partial content',{headers:{ETag:'old','Set-Cookie':'secret'}});
  });
  expect(response.status).toBe(503);expect(await response.text()).toContain(VISITOR_LIMIT);expect(native.calls()).toBe(1);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, no-transform');
  for(const key of ['ETag','Last-Modified','Location','Set-Cookie'])expect(response.headers.has(key)).toBe(false);
 }
});
it('HEAD/JSON use safe fixed bodies and inherited credentials do not authorize owner copy',async()=>{
 for(const method of ['GET','HEAD','POST']){
  const response=await dailyRequest(new Request(origin+'/review/options?code=hidden',{method,headers:{Cookie:'owner=fake',Authorization:'Bearer fake','Content-Type':'application/json'}}),fake(provider()).database,async wrapped=>{await wrapped.prepare('SELECT 1').first();return new Response('never');});
  expect(response.status).toBe(503);
  if(method==='HEAD')expect(await response.text()).toBe('');
  else expect(await response.json()).toEqual({error:'free_daily_limit',message:VISITOR_LIMIT});
 }
});
it.each(['D1_ERROR: database is locked','D1_ERROR: near "Your account has exceeded D1\'s free tier daily row read limit.": syntax error','Your account has exceeded D1\'s maximum account storage limit','429','1027','D1 DB exceeded its CPU time limit and was reset.'])('generic/lookalike native error is not a daily allowance: %s',async text=>{
 const error=new Error(text);await expect(dailyRequest(new Request(origin),fake(error).database,async wrapped=>{await wrapped.prepare('SELECT 1').first();return new Response();})).rejects.toBe(error);
});
it('bounded native binding cause is classified; application cause is not scanned',async()=>{
 const error=new Error('wrapper',{cause:provider('write')});
 const response=await dailyRequest(new Request(origin),fake(error).database,async wrapped=>{await wrapped.prepare('SELECT 1').first();return new Response();});expect(response.status).toBe(503);
 const application=new Error('application',{cause:provider()});
 await expect(dailyRequest(new Request(origin),db,async()=>{throw application;})).rejects.toBe(application);
});
it('optional errors, concurrent calls and subsequent requests cannot contaminate another response',async()=>{
 const native=fake(provider());
 const optional=await dailyRequest(new Request(origin),native.database,async wrapped=>{
  await optionalD1(()=>wrapped.prepare('SELECT 1').first()).catch(()=>{});
  return new Response('already valid');
 });
 expect(await optional.text()).toBe('already valid');
 const [bad,good]=await Promise.all([
  dailyRequest(new Request(origin),native.database,async wrapped=>{await wrapped.prepare('SELECT 1').first();return new Response();}),
  dailyRequest(new Request(origin),db,async wrapped=>new Response(String(await wrapped.prepare('SELECT 7 AS n').first('n')))),
 ]);
 expect(bad.status).toBe(503);expect(await good.text()).toBe('7');
});
it('tool failures preserve fixed writer/read variants and do not share authorization or failure',async()=>{
 const native=fake(provider());
 const response=await dailyRequest(new Request(origin),native.database,async wrapped=>{
  const writer=await dailyTool(async()=>{dailyOwnerAuthorized();await wrapped.prepare('SELECT 1').first();});
  const reader=await dailyTool(async()=>{await wrapped.prepare('SELECT 1').first();});
  const success=await dailyTool(async()=>({content:[{type:'text',text:'unaffected'}]}));
  expect(JSON.parse(writer.content[0].text)).toEqual({error:'free_daily_limit',message:OWNER_LIMIT});
  expect(JSON.parse(reader.content[0].text)).toEqual({error:'free_daily_limit',message:VISITOR_LIMIT});
  expect(writer.isError).toBe(true);expect(reader.isError).toBe(true);expect(success.content[0].text).toBe('unaffected');
  return new Response('transport preserved');
 });
 expect(await response.text()).toBe('transport preserved');expect(native.calls()).toBe(2);
});
it('native first/raw metadata and atomic batch input are transparent on success',async()=>{
 const wrapped=dailyDatabase(db);
 expect(await wrapped.prepare('SELECT 8 AS n').first('n')).toBe(8);
 expect(await wrapped.prepare('SELECT 9 AS n').raw()).toEqual([[9]]);
 const batch=await wrapped.batch([wrapped.prepare('SELECT ? AS n').bind(10),wrapped.prepare('SELECT ? AS n').bind(11)]);
 expect(batch.map(x=>x.results)).toEqual([[{n:10}],[{n:11}]]);
 expect(batch.every(x=>Number.isInteger(x.meta.rows_read)&&Number.isInteger(x.meta.rows_written))).toBe(true);
});
// Inject only at a simulated native execution boundary; product auth and handlers run.
function faultDB(test:(sql:string)=>boolean){
 const nativeStatements=new WeakMap<object,object>();
 function stmt(native:D1PreparedStatement,sql:string):D1PreparedStatement{
  const wrapped=new Proxy(native,{get(target,key){
   if(key==='bind')return (...args:any[])=>stmt(target.bind(...args),sql);
   const value=Reflect.get(target,key,target);
   if(['all','first','raw','run'].includes(String(key)))return (...args:any[])=>test(sql)?Promise.reject(provider()):value.apply(target,args);
   return typeof value==='function'?value.bind(target):value;
  }});nativeStatements.set(wrapped,native);return wrapped;
 }
 return new Proxy(db,{get(target,key){
  if(key==='prepare')return (sql:string)=>stmt(target.prepare(sql),sql);
  if(key==='batch')return (statements:D1PreparedStatement[])=>target.batch(statements.map(s=>(nativeStatements.get(s)??s) as D1PreparedStatement));
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
}
beforeEach(async()=>{
 const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name} of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();
});
it('actual Worker unknown privacy/auth fails closed without identifiers, including HEAD',async()=>{
 for(const path of ['/','/review','/mcp'])for(const method of ['GET','HEAD']){
  const response=await worker.fetch(new Request(origin+path,{method,headers:{Cookie:'owner=forged',Authorization:'Bearer psk_invalid'}}),{...e,DB:faultDB(()=>true)},context);
  // Malformed credential refusals completed before D1 keep precedence.
  expect([401,503]).toContain(response.status);
  const text=await response.text();expect(text).not.toContain('D1_ERROR');expect(text).not.toContain('psk_invalid');
  if(method==='HEAD')expect(text).toBe('');
 }
});
it.each([false,true])('actual writer tool handler quota is a tool error with id retained, SDK=%s',async fallback=>{
 const {token}=await keys.create(db,'Fixture');
 const request=new Request(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:'quota-case',method:'tools/call',params:{name:'site_state',arguments:{},...(fallback?{_meta:{fixture:true}}:{})}})});
 const response=await worker.fetch(request,{...e,DB:faultDB(sql=>/FROM items\b/.test(sql))},context);
 expect(response.status).toBe(200);expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");const text=await response.text();
 const wire=JSON.parse(text.startsWith('{')?text:text.split('\n').find(l=>l.startsWith('data:'))!.slice(5));
 expect(wire.id).toBe('quota-case');expect(wire.result.isError).toBe(true);
 expect(JSON.parse(wire.result.content[0].text)).toEqual({error:'free_daily_limit',message:OWNER_LIMIT});
 expect(text).not.toContain('D1_ERROR');expect(text).not.toContain(token);
});
it('valid reader credential cannot obtain the owner error variant',async()=>{
 const {token}=await readKeys.create(db,'Fixture');
 const request=new Request(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'site_state',arguments:{}}})});
 const response=await worker.fetch(request,{...e,DB:faultDB(sql=>/FROM live\b/.test(sql))},context);
 const text=await response.text();expect(text).toContain(VISITOR_LIMIT);expect(text).not.toContain(OWNER_LIMIT);expect(text).not.toContain('D1_ERROR');
});
it('authenticated real owner review gets owner copy, but invalid CSRF still refuses',async()=>{
 const {SoftKey}=await import('./softkey');const key=await SoftKey.make();let cookie='';
 const post=async(path:string,body:unknown)=>{
  const response=await worker.fetch(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)}),e,context);
  const fresh=response.headers.getSetCookie().map(h=>h.split(';')[0]);if(fresh.length)cookie=fresh.join('; ');return response;
 };
 const options=await post('/setup/options',{code:e.SETUP_CODE,name:'Fixture'});expect(options.status).toBe(200);
 const issued=await post('/setup/verify',await key.create((await options.json() as any).options,origin));expect(issued.status).toBe(200);
 const faulted={...e,DB:faultDB(sql=>/FROM items\b/.test(sql))};
 const review=await worker.fetch(new Request(origin+'/review',{headers:{Cookie:cookie}}),faulted,context);
 expect(review.status).toBe(503);const text=await review.text();expect(text).toContain(OWNER_LIMIT);expect(text).not.toContain(cookie);
 const refused=await worker.fetch(new Request(origin+'/review/readers',{method:'POST',headers:{Cookie:cookie,Origin:'https://outside.example','Content-Type':'application/x-www-form-urlencoded'},body:'csrf=invalid'}),faulted,context);
 expect(refused.status).toBe(403);expect(await refused.text()).not.toContain(OWNER_LIMIT);
});
it('a final-facts daily failure cannot return rendered content, cached validators or a 304',async()=>{
 const content=await import('../src/content'),approvals=await import('../src/approvals'),read=await import('../src/public-read');
 const one=await content.createItem(db,'assistant:test','site',{title:'Content must stay hidden on failure',theme:'personal-homepage'},undefined);
 await approvals.publishNow(db,[{id:one.id,version:one.version}],'',origin);
 const healthy=await worker.fetch(new Request(origin),{...e,SITE_URL:origin},context);expect(healthy.status).toBe(200);const tag=healthy.headers.get('ETag')!;
 for(const conditional of [false,true]){
  let facts=0,triggered=false;
  const failed=await worker.fetch(new Request(origin,{headers:conditional?{'If-None-Match':tag}:{}}),{...e,SITE_URL:origin,DB:faultDB(sql=>{if(sql!==read.FACTS_SQL)return false;facts++;if(facts===2){triggered=true;return true;}return false;})},context);
  expect(triggered).toBe(true);expect(failed.status).toBe(503);expect(failed.headers.has('ETag')).toBe(false);
  const text=await failed.text();expect(text).toContain(VISITOR_LIMIT);expect(text).not.toContain('Content must stay hidden on failure');
 }
});
