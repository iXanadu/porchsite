/** Optional local response reuse. The caller has already run the live gate. */
import * as read from './public-read';
import {configuredOrigin,digest,type Proof,type Render} from './public-artifacts';
import {sessionRequest,PUBLIC_CACHE} from './public-http';
import {plan,valid,type Plan} from './public-time';
import {blankResponse} from './privacy';

export const FORMAT='public-responses/1',MAX_BODY=256*1024,MAX_METADATA=8192,MAX_KEY=2048,MAX_AGE=7200000;
const INTERNAL='x-porchsite-response',encode=new TextEncoder();
let fills=0;
const size=(s:string)=>encode.encode(s).length;
/** No request headers or visitor identity enter this synthetic GET. */
export async function key(origin:string,release:string,c:read.Choice,tag:string):Promise<Request|null>{
 const url=origin+'/.porchsite-response/'+await digest(JSON.stringify([FORMAT,release,origin,c.base+c.query,c.type,tag]));
 return size(url)<=MAX_KEY?new Request(url,{method:'GET'}):null;
}
export function eligible(req:Request,origin:string|null,p?:Proof):p is Proof&{tag:string}{
 return !!origin&&new URL(req.url).origin===origin&&['GET','HEAD'].includes(req.method)&&!sessionRequest(req)&&!req.headers.has('Range')&&!!p?.tag&&!p.facts.private&&p.facts.hasSite&&['html','markdown','map'].includes(p.choice.kind);
}
export async function boundedBody(response:Response):Promise<Uint8Array|null>{
 if(!response.body)return new Uint8Array();
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let count=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;count+=value.length;if(count>MAX_BODY){void reader.cancel().catch(()=>{});return null;}parts.push(value);}}
 finally{reader.releaseLock();}
 const result=new Uint8Array(count);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
const bodyDigest=async(body:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',body))].map(x=>x.toString(16).padStart(2,'0')).join('');
function sameChoice(a:read.Choice|null,b:read.Choice){return a&&a.base===b.base&&a.query===b.query&&a.kind===b.kind&&a.type===b.type;}
async function current(db:D1Database,req:Request,p:Proof,clock:Plan){
 const fresh=await read.facts(db);
 if(fresh.private)return 'private';
 return JSON.stringify(fresh.rows)===JSON.stringify(p.facts.rows)&&sameChoice(read.choice(req,fresh),p.choice)&&valid(clock)?'same':'changed';
}
function canonicalHeaders(p:Proof&{tag:string},origin:string){const h=read.headers(p.facts,p.choice,p.tag,origin);h.delete('Vary');return h;}
function storable(response:Response,p:Proof&{tag:string},origin:string){
 if(response.status!==200||response.headers.get('Cache-Control')!==PUBLIC_CACHE)return false;
 const expected=read.headers(p.facts,p.choice,p.tag,origin);
 // Reject every unkeyed dimension or response extension rather than cache it.
 return [...response.headers].every(([name,value])=>expected.get(name)===value)&&[...expected].every(([name,value])=>response.headers.get(name)===value);
}
async function stored(response:Response,p:Proof&{tag:string},origin:string,clock:Plan){
 if(response.status!==200||size(JSON.stringify([...response.headers]))>MAX_METADATA)return null;
 const raw=response.headers.get(INTERNAL);if(!raw||size(raw)>MAX_METADATA)return null;
 let meta:any;try{meta=JSON.parse(raw);}catch{return null;}
 if(!Array.isArray(meta)||meta.length!==6||meta[0]!==FORMAT||meta[1]!==p.tag||!Number.isSafeInteger(meta[2])||!Number.isSafeInteger(meta[3])||!Number.isSafeInteger(meta[4])||meta[4]<0||meta[4]>MAX_BODY||!/^[a-f0-9]{64}$/.test(meta[5]))return null;
 const now=Date.now();if(now<meta[2]||now>=meta[3]||meta[3]<=meta[2]||meta[3]-meta[2]>MAX_AGE||!valid(clock))return null;
 const expected=canonicalHeaders(p,origin);
 if([...expected].some(([name,value])=>name!=='cache-control'&&response.headers.get(name)!==value))return null;
 const allowed=new Set([...expected.keys(),INTERNAL,'age','date','content-length','cf-cache-status']);
 if([...response.headers].some(([name])=>!allowed.has(name))||!/^public, max-age=[0-9]+$/.test(response.headers.get('Cache-Control')??''))return null;
 const body=await boundedBody(response);if(!body||body.length!==meta[4]||await bodyDigest(body)!==meta[5])return null;
 return {body,expires:meta[3],born:meta[2]};
}
/** Cache failures are misses; only the final fresh facts authorize a hit. */
export async function respond(db:D1Database,req:Request,configured:string|undefined,release:string,p:Proof|undefined,render:Render,refresh:Render,onHit:()=>void,waitUntil?:(work:Promise<unknown>)=>void):Promise<Response>{
 const origin=configuredOrigin(configured);if(!eligible(req,origin,p))return render();
 const clock=plan(p.facts,p.choice,p.now);if(!valid(clock))return render();
 const request=await key(origin!,release,p.choice,p.tag);if(!request)return render();
 let cache:Cache;try{cache=caches.default;}catch{return render();}
 try{
  const found=await cache.match(request);
  const hit=found?await stored(found,p,origin!,clock):null;
  if(hit){
   const proof=await current(db,req,p,clock);
   if(proof==='private')return blankResponse(req);
   if(proof!=='same'||Date.now()<hit.born||Date.now()>=hit.expires)return refresh();
   onHit();return new Response(req.method==='HEAD'?null:hit.body,{headers:read.headers(p.facts,p.choice,p.tag,origin!)});
  }
 }catch{/* An unavailable or malformed store is not a stale fallback. */}
 const response=await render();
 if(req.method!=='GET'||fills>=2||!storable(response,p,origin!))return response;
 fills++;
 const work=(async()=>{
  const body=await boundedBody(response.clone());if(!body)return;
  const hash=await bodyDigest(body),now=Date.now(),until=Math.min(p.now+MAX_AGE,clock.next_change??Infinity);
  const ttl=Math.floor((until-now)/1000);if(ttl<1||!valid(clock))return;
  const expires=now+ttl*1000,meta=JSON.stringify([FORMAT,p.tag,p.now,expires,body.length,hash]);
  const headers=canonicalHeaders(p,origin!);headers.set(INTERNAL,meta);headers.set('Cache-Control',`public, max-age=${ttl}`);
  if(size(JSON.stringify([...headers]))>MAX_METADATA)return;
  const clone=new Response(body,{headers});
  if(await current(db,req,p,clock)!=='same'||!valid(clock)||Date.now()>=expires)return;
  await cache.put(request,clone);
 })().catch(()=>{}).finally(()=>{fills--;});
 if(waitUntil)waitUntil(work);else await work;
 return response;
}
