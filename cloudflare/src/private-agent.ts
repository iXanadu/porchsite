/** Authorized private reads exist only in request memory, never artifact storage. */
import * as owner from './owner';
import {ApiError} from './errors';
import * as keys from './read-keys';
import {blankResponse,noStore,PrivateContentDenied} from './privacy';
import {snapshot,digest,displayBoundary} from './public-artifacts';
import {markdownPath,pagePath,pageQuery,representation,matchesTag,privateAgentPath} from './public-http';
export const PRIVATE_LIGHT='private, no-cache, must-revalidate, no-transform';
type Principal={kind:string;id:string;epoch:string;props?:keys.Props};
type Guard=()=>Promise<void>;
type Render=(req:Request,guard:Guard)=>Promise<Response>;
export async function principal(db:D1Database,req:Request):Promise<Principal|null>{
 if(req.headers.has('Authorization')){
  const token=/^Bearer[\t ]+(prk_[A-Za-z0-9_-]{32})$/i.exec(req.headers.get('Authorization')??'')?.[1];
  const props=token?await keys.lookup(db,token):null;
  return props?{kind:'key',id:props.readKeyId,epoch:String(props.ownerEpoch),props}:null;
 }
 const kind=await owner.signedIn(db,req)?'owner':await owner.readerSignedIn(db,req)?'reader':null;
 if(!kind)return null;
 const gate=kind==='owner'?await owner.ownerSessionGuard(req):await owner.readerSessionGuard(req),hash=gate.args[0];
 // Only live sessions may acquire opaque metadata. Existing mappings never authorize.
 await db.batch([
  db.prepare("DELETE FROM agent_read_session_ids WHERE kind='owner' AND NOT EXISTS(SELECT 1 FROM sessions s JOIN auth_state a ON a.id=1 LEFT JOIN owner_session_auth m ON m.token_hash=s.token_hash WHERE s.token_hash=session_hash AND s.expires_at>? AND ((m.token_hash IS NULL AND a.owner_epoch=0) OR (m.epoch=a.owner_epoch AND EXISTS(SELECT 1 FROM passkeys WHERE id=m.credential_id))))").bind(new Date().toISOString()),
  db.prepare("DELETE FROM agent_read_session_ids WHERE kind='reader' AND NOT EXISTS(SELECT 1 FROM reader_sessions s JOIN readers r ON r.id=s.reader_id JOIN reader_passkeys p ON p.id=s.credential_id AND p.reader_id=r.id WHERE s.token_hash=session_hash AND s.expires_at>? AND r.revoked=0 AND r.auth_epoch=s.epoch)").bind(new Date().toISOString()),
  db.prepare('INSERT OR IGNORE INTO agent_read_session_ids(kind,session_hash,id) SELECT ?,?,? WHERE '+gate.sql).bind(kind,hash,crypto.randomUUID(),...gate.args),
 ]);
 const row=await db.prepare('SELECT id FROM agent_read_session_ids WHERE kind=? AND session_hash=? AND '+gate.sql).bind(kind,hash,...gate.args).first<{id:string}>();
 if(!row)return null;
 const epoch=kind==='owner'?await db.prepare('SELECT owner_epoch FROM auth_state WHERE id=1').first<number>('owner_epoch'):await db.prepare('SELECT epoch FROM reader_sessions WHERE token_hash=?').bind(hash).first<number>('epoch');
 return epoch===null?null:{kind,id:row.id,epoch:String(epoch)};
}
const identity=(p:Principal)=>JSON.stringify([p.kind,p.id,p.epoch]);
export async function valid(db:D1Database,req:Request,p:Principal){const fresh=await principal(db,req);return !!fresh&&identity(fresh)===identity(p);}
/** null leaves an existing passkey HTML/protocol path to its ordinary handler. */
export async function respond(db:D1Database,req:Request,render:Render):Promise<Response|null>{
 const path=new URL(req.url).pathname,base=markdownPath(path),page=pagePath(path),copy=path==='/llms.txt'||!!base;
 if(path==='/collect')return null;
 const candidate=['GET','HEAD'].includes(req.method)&&(copy||page);
 if(!candidate){if(req.headers.has('Authorization')||privateAgentPath(req))return blankResponse(req);return null;}
 const selected=copy?'markdown':representation(req.headers.get('Accept'));
 // Ordinary session HTML retains its existing bytes and policy.
 if(!req.headers.has('Authorization')&&!copy&&selected==='html')return null;
 const p=await principal(db,req);if(!p)return blankResponse(req);
 const guard=async()=>{if(!await valid(db,req,p))throw new PrivateContentDenied();};
 const get=req.method==='HEAD'?new Request(req,{method:'GET'}):req;
 try{
  for(let attempt=0;attempt<2;attempt++){
   await guard();const stamp=await snapshot(db),until=displayBoundary(Date.now());
   const response=await render(get,guard);
   if(!await valid(db,req,p))return blankResponse(req);
   if(await snapshot(db)!==stamp||Date.now()>=until)continue;
   const type=response.headers.get('Content-Type')??'';
   if(response.status!==200||type!=='text/markdown; charset=utf-8'){if(response.status===200&&p.props)await keys.used(db,p.props);if(!await valid(db,req,p))return blankResponse(req);if(await snapshot(db)!==stamp||Date.now()>=until)continue;return noStore(response);}
   const body=await response.text(),canonical=new URL((base??path)+pageQuery(req,base??path),req.url).href;
   const g=await digest(JSON.stringify([canonical,type,body]));
   const tag=`W/"ag-sha256-${await digest(JSON.stringify(['ag-private/1',p.kind,p.id,p.epoch,canonical,type,g,body]))}"`;
   const headers=new Headers(response.headers);
   for(const name of ['Content-Signal','Last-Modified','Age','Set-Cookie','CDN-Cache-Control','Cloudflare-CDN-Cache-Control','Surrogate-Control'])headers.delete(name);
   headers.set('Cache-Control',PRIVATE_LIGHT);headers.set('X-Robots-Tag','noindex');headers.set('ETag',tag);
   headers.set('Content-Length',String(new TextEncoder().encode(body).length));
   if(p.props)await keys.used(db,p.props);
   if(!await valid(db,req,p))return blankResponse(req);
   if(await snapshot(db)!==stamp||Date.now()>=until)continue;
   const match=matchesTag(req.headers.get('If-None-Match'),tag);if(match)headers.delete('Content-Length');
   return new Response(match?null:body,{status:match?304:200,headers});
  }
  return new Response(null,{status:503,headers:{'Cache-Control':'private, no-store, no-transform'}});
 }catch(error){if(error instanceof PrivateContentDenied||(error instanceof ApiError&&error.code==='unauthorized'))return blankResponse(req);throw error;}
}
