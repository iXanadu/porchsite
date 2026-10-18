/** Specific D1 Free daily errors; no plan probes or cross-request quota state. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {RELEASE} from './home';
import {oauthCors} from './oauth-cors';

export const COST_FACTS = "Cloudflare cost facts: ask which plan; never assume. Free Workers/D1 have no usage bill; daily limits reset at midnight UTC. Paid usage has no hard spending cap. Never upgrade, add payment or enable a paid feature without the owner's separate explicit yes.";
export const VISITOR_LIMIT = "This site has reached today's free limit on its hosting. The free allowance resets at midnight UTC.";
export const OWNER_LIMIT = "This site has used today's free Cloudflare allowance, so it can't save changes until midnight UTC. Nothing has been charged for Workers or D1 usage on the free plan. Usage is under D1, then Metrics, in the Cloudflare dashboard.";
type Limit = 'read'|'write';
type State = {failure?:Limit; authorized?:boolean; optional?:boolean; db?:D1Database; pending?:Promise<void>[]; toolFailure?:boolean};
const requests = new AsyncLocalStorage<State>();
class DailyLimit extends Error {constructor(){super(VISITOR_LIMIT);}}
const message = (state:State) => state.authorized ? OWNER_LIMIT : VISITOR_LIMIT;
const refusal = (state:State) => ({error:'free_daily_limit',message:message(state)});

/** Called only for an exception returned by a native binding invocation. */
function bindingLimit(error:unknown):Limit|undefined {
 let current=error;
 for(let depth=0;depth<3;depth++){
  if(!(current instanceof Error))return;
  const text=current.message;
  if(typeof text==='string'&&text.length<=2048){
   const match=/^(?:D1_ERROR: )?Your account has exceeded D1's free tier daily row (read|write) limit\.(?:$| )/.exec(text);
   if(match)return match[1] as Limit;
  }
  current=current.cause;
 }
}
const databases=new WeakMap<object,D1Database|D1DatabaseSession>();
const originals=new WeakMap<object,object>();
export function databaseIdentity(db:D1Database):D1Database{return (originals.get(db)??db) as D1Database;}
/** Transparent method/batch wrapper: successful values and native counts stay intact. */
export function dailyDatabase<T extends D1Database|D1DatabaseSession>(db:T):T {
 if(originals.has(db))return db;
 const old=databases.get(db);if(old)return old as T;
 const statements=new WeakMap<object,object>();
 async function execute(target:object,key:PropertyKey,args:unknown[]){
  const state=requests.getStore();
  if(state?.failure)throw new DailyLimit();
  try{return await Reflect.get(target,key,target).apply(target,args);}
  catch(error){
   const kind=bindingLimit(error);
   if(!kind)throw error;
   if(state&&!state.optional)state.failure=kind;
   throw new DailyLimit();
  }
 }
 function statement(native:object):object {
  const found=statements.get(native);if(found)return found;
  const wrapped=new Proxy(native,{get(target,key){
   if(key==='bind')return (...args:unknown[])=>statement(Reflect.get(target,key,target).apply(target,args));
   if(['all','first','raw','run'].includes(String(key)))return (...args:unknown[])=>execute(target,key,args);
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  statements.set(native,wrapped);originals.set(wrapped,native);return wrapped;
 }
 const wrapped=new Proxy(db,{get(target,key){
  if(key==='prepare')return (query:string)=>statement(target.prepare(query));
  if(key==='batch')return (batch:object[])=>execute(target,key,[batch.map(s=>originals.get(s)??s)]);
  if(key==='exec')return (...args:unknown[])=>execute(target,key,args);
  if(key==='withSession')return (constraintOrBookmark?:string)=>dailyDatabase((target as D1Database).withSession(constraintOrBookmark));
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 databases.set(db,wrapped);originals.set(wrapped,db);return wrapped;
}
/** Optional work owns a separate context, even while its caller is still active. */
export function optionalD1<T>(fn:()=>T):T {return requests.run({optional:true,db:requests.getStore()?.db},fn);}
export function dailyOwnerAuthorized(){const state=requests.getStore();if(state)state.authorized=true;}
const headers={
 'Cache-Control':'private, no-store, no-transform','Referrer-Policy':'no-referrer',
 'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
function response(req:Request,state:State){
 const path=new URL(req.url).pathname;
 const json=path==='/mcp'||req.headers.get('Content-Type')?.includes('json')||path.endsWith('/options')||path.endsWith('/verify');
 const body=json?JSON.stringify(refusal(state)):'<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Free daily limit reached</title><p>'+message(state)+'</p>';
 const out=oauthCors(path,new Response(req.method==='HEAD'?null:body,{status:503,headers:{...headers,'Content-Type':json?'application/json; charset=utf-8':'text/html; charset=utf-8'}}));
 out.headers.set('X-Porchsite-Release',RELEASE);return out;
}
/** Required failures survive broad internal fail-closed/render catches. */
export function toolDatabase(fallback:D1Database){return requests.getStore()?.db??fallback;}
export function dailyRequest(req:Request,db:D1Database,fn:(db:D1Database)=>Promise<Response>):Promise<Response>{
 return requests.run({db:dailyDatabase(db)},async()=>{
  const state=requests.getStore()!;
  try{
   const result=await fn(state.db!);
   // The SDK may create its event stream before an async callback finishes.
   // Wait for callbacks, not response bodies, so large results are not copied.
   for(let count=0;state.pending&&count<state.pending.length;){const pending=state.pending.slice(count);count=state.pending.length;await Promise.all(pending);}
   if(state.failure)return response(req,state);
   if(!state.toolFailure)return result;
   const out=new Response(result.body,result);
   for(const [name,value] of Object.entries(headers))out.headers.set(name,value);
   for(const name of ['ETag','Last-Modified','Location','Set-Cookie'])out.headers.delete(name);
   return out;
  }
  catch(error){if(state.failure)return response(req,state);throw error;}
 });
}
/** A handler's quota state never contaminates another call in an SDK batch. */
export function dailyTool(fn:()=>Promise<any>):Promise<any>{
 const parent=requests.getStore();
 const task=requests.run({db:parent?.db},async()=>{
  const state=requests.getStore()!;
  const failed=()=>{if(parent)parent.toolFailure=true;return {content:[{type:'text' as const,text:JSON.stringify(refusal(state))}],isError:true};};
  try{const value=await fn();return state.failure?failed():value;}
  catch(error){if(state.failure)return failed();throw error;}
 });
 if(parent)(parent.pending??=[]).push(task.then(()=>{},()=>{}));
 return task;
}
