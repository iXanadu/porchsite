/** Request-local writer validation. Tokens never enter tool props or results. */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Env} from './env';
import * as keys from './keys';
import {RELEASE} from './home';
import {ApiError} from './errors';
import type {Context} from './preview-read';
const requests=new AsyncLocalStorage<{req:Request;env:Env;state:{preview:boolean}}>();
export const withPreviewRequest=<T>(req:Request,env:Env,fn:()=>T):T=>requests.run({req,env,state:requests.getStore()?.state??{preview:false}},fn);
export function markPreviewRead(){const value=requests.getStore();if(value)value.state.preview=true;}
export const skipPublicPreparation=()=>requests.getStore()?.state.preview===true;
export function previewContext(props:Record<string,unknown>):Context|undefined{
 const request=requests.getStore();if(!request)return;
 markPreviewRead();
 const {req,env}=request;
 return {origin:env.SITE_URL??'',siteOrigin:String(props.origin),release:RELEASE,authorize:async()=>{
  const refuse=():never=>{throw new ApiError(403,'unauthorized','This tool requires a live drafting connection.');};
  const token=/^Bearer[\t ]+([^\s,]+)$/i.exec(req.headers.get('Authorization')??'')?.[1];if(!token||token.startsWith('prk_')||props.scope==='published_read')return refuse();
  let principal:string;
  if(token.startsWith('psk_')){const current=await keys.lookup(env.DB,token,false);if(!current||current.clientId!==props.clientId)return refuse();principal=current.clientId;}
  else{
   const summary=await env.OAUTH_PROVIDER?.unwrapToken(token);if(!summary||summary.expiresAt<=Date.now()/1000||summary.userId!=='owner'||!summary.scope.includes('site:draft')||summary.grant.clientId!==props.clientId||summary.grant.props?.origin!==props.origin)return refuse();
   const audience=summary.audience;if(audience!==String(props.origin)+'/mcp'&&!(Array.isArray(audience)&&audience.length===1&&audience[0]===String(props.origin)+'/mcp'))return refuse();
   let cursor:string|undefined,found=false;for(let pages=0;pages<8;pages++){const list=await env.OAUTH_PROVIDER.listUserGrants(summary.userId,{limit:100,cursor});if(list.items.some(g=>g.id===summary.grantId&&g.clientId===summary.grant.clientId&&(!g.expiresAt||g.expiresAt>Date.now()/1000))){found=true;break;}cursor=list.cursor;if(!cursor)break;}if(!found)return refuse();principal='oauth:'+summary.userId+':'+summary.grantId;
  }
  const epoch=await env.DB.prepare('SELECT owner_epoch FROM auth_state WHERE id=1').first<number>('owner_epoch');if(epoch===null)return refuse();return {principal,epoch};
 }};
}
