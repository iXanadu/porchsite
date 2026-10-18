import * as owner from './owner';
/** Published-only credentials; never stored in assistant_keys. */
import {ApiError} from './errors';
import {checkGuard} from './guard';
export const PREFIX='prk_', KEY_DAYS=90;
export const ALLOWED=new Set(['site_state','site_check','page_get','pages_list','search']);
export const INSTRUCTIONS='Published pages can be read with site_state, site_check, page_get, pages_list and search. This connection cannot draft, read owner review or publish.';
const hex=(value:ArrayBuffer)=>[...new Uint8Array(value)].map(x=>x.toString(16).padStart(2,'0')).join('');
const hash=async(value:string)=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
const id=()=>hex(crypto.getRandomValues(new Uint8Array(12)).buffer);
export type Props={scope:'published_read';readKeyId:string;ownerEpoch:number;client:string;clientId:string};
export function restricted(props:Record<string,unknown>){return props.scope==='published_read';}
export async function create(db:D1Database,name:string,actor='owner',req?:Request){
 checkGuard(name);
 const bytes=crypto.getRandomValues(new Uint8Array(24)),token=PREFIX+btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const keyId='read_'+id(),at=new Date().toISOString(),expires_at=new Date(Date.now()+KEY_DAYS*86400000).toISOString();
 const gate=req?await owner.ownerSessionGuard(req):{sql:'1',args:[]};
 const writes=await db.batch([
  db.prepare('INSERT INTO agent_read_keys(id,name,key_hash,created_at,expires_at,owner_epoch) SELECT ?,?,?,?,?,owner_epoch FROM auth_state WHERE id=1 AND '+gate.sql).bind(keyId,name,await hash(token),at,expires_at,...gate.args),
  db.prepare("INSERT INTO agent_read_key_events(id,created_at,actor,key_id,name,kind) SELECT ?,?,?,id,name,'created' FROM agent_read_keys WHERE id=?").bind('event_'+id(),at,actor,keyId),
 ]);
 if(writes[0].meta.changes!==1)throw new ApiError(403,'not_verified','This sign-in stopped working. Start again.');
 return {id:keyId,token,expires_at};
}
export async function list(db:D1Database){return (await db.prepare('SELECT id,name,created_at,expires_at,last_used_at FROM agent_read_keys WHERE revoked_at IS NULL AND expires_at>? AND owner_epoch=(SELECT owner_epoch FROM auth_state WHERE id=1) ORDER BY created_at DESC,id').bind(new Date().toISOString()).all<{id:string;name:string;created_at:string;expires_at:string;last_used_at:string|null}>()).results;}
export async function events(db:D1Database){return (await db.prepare('SELECT created_at,actor,key_id,name,kind FROM agent_read_key_events ORDER BY created_at DESC,id').all<{created_at:string;actor:string;key_id:string;name:string;kind:string}>()).results;}
export async function revoke(db:D1Database,keyId:string,actor='owner',req?:Request){
 if(req&&!await owner.signedIn(db,req))throw new ApiError(403,'not_verified','This sign-in stopped working. Start again.');
 const gate=req?await owner.ownerSessionGuard(req):{sql:'1',args:[]};
 const at=new Date().toISOString();
 await db.batch([
  db.prepare("INSERT INTO agent_read_key_events(id,created_at,actor,key_id,name,kind) SELECT ?,?,?,id,name,'revoked' FROM agent_read_keys WHERE id=? AND revoked_at IS NULL AND "+gate.sql).bind('event_'+id(),at,actor,keyId,...gate.args),
  db.prepare('UPDATE agent_read_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND '+gate.sql).bind(at,keyId,...gate.args),
 ]);
}
export async function lookup(db:D1Database,token:string):Promise<Props|null>{
 if(!/^prk_[A-Za-z0-9_-]{32}$/.test(token))return null;
 const row=await db.prepare('SELECT id,name,owner_epoch FROM agent_read_keys WHERE key_hash=? AND revoked_at IS NULL AND expires_at>? AND owner_epoch=(SELECT owner_epoch FROM auth_state WHERE id=1)').bind(await hash(token),new Date().toISOString()).first<{id:string;name:string;owner_epoch:number}>();
 return row?{scope:'published_read',readKeyId:row.id,ownerEpoch:row.owner_epoch,client:row.name,clientId:'read:'+row.id}:null;
}
export async function valid(db:D1Database,props:Record<string,unknown>){
 return !!await db.prepare('SELECT id FROM agent_read_keys WHERE id=? AND owner_epoch=? AND owner_epoch=(SELECT owner_epoch FROM auth_state WHERE id=1) AND revoked_at IS NULL AND expires_at>?').bind(props.readKeyId,props.ownerEpoch,new Date().toISOString()).first();
}
export async function authorize(db:D1Database,props:Record<string,unknown>,name?:string){
 if(restricted(props)&&(!await valid(db,props)||(name!==undefined&&!ALLOWED.has(name))))throw new ApiError(403,'unauthorized','This connection can only read published pages.');
}
export async function used(db:D1Database,props:Record<string,unknown>){
 await authorize(db,props);
 const row=await db.prepare('UPDATE agent_read_keys SET last_used_at=? WHERE id=? AND revoked_at IS NULL AND owner_epoch=? AND owner_epoch=(SELECT owner_epoch FROM auth_state WHERE id=1) AND expires_at>? RETURNING id').bind(new Date().toISOString(),props.readKeyId,props.ownerEpoch,new Date().toISOString()).first();
 if(!row)throw new ApiError(403,'unauthorized','This connection can only read published pages.');
}
