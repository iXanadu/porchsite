// Local measurement wrapper only. Never shipped as an application route.
import './clock.mjs';
import application from './application-measured.js';
import {runScoped,registerContext} from './wait-scope.mjs';
import * as native from 'cloudflare:workers';
import * as adapter from './native-workers.mjs';
import {observer,counters,settle} from './observer.mjs';
const allowedHeaders=['cache-control','location','content-type'];
export default { async fetch(_request,env,context) {
  for(const key of Object.keys(native))if(key!=='waitUntil'&&!Object.is(native[key],adapter[key]))throw Error('Native export identity changed');
  let state=counters();
  const scope=new Proxy({}, {get:(_,k)=>state[k],set:(_,k,v)=>{state[k]=v;return true;}});
  const db=observer(env.DB,scope);
  const applicationEnv={DB:db,OAUTH_KV:env.OAUTH_KV,SITE_URL:env.SITE_URL,PUBLIC_ARTIFACTS:env.PUBLIC_ARTIFACTS,PUBLIC_RESPONSES:''};
  async function dispatch(request) {
    const pending=[];
    const scoped=await runScoped(async()=>{
    const response=await application.fetch(request,applicationEnv,{...context,props:context.props,passThroughOnException:context.passThroughOnException.bind(context),waitUntil:p=>{pending.push(p);registerContext(p);}});
    const body=await response.text();await settle(pending);return {response,body};});
    const {response,body}=scoped.value;
    if(env.ROW_OPERATION==='import/file'&&request.method==='POST'&&env.ROW_AUTH==='valid'&&scoped.nativeRegistrations<1)throw Error('Native background task adapter missing');
    if(state.failed)throw Error('Row operation database failure');state.closed=true;
    return {response,body};
  }
  try {
    const origin=env.SITE_URL;let request;const headers={Origin:origin,'User-Agent':'Mozilla/5.0 SyntheticBrowser','cf-connecting-ip':'192.0.2.40'};
    const op=env.ROW_OPERATION;
    if(op.startsWith('collect/'))request=new Request(origin+'/collect',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:env.ROW_BODY});
    else {
      if(env.ROW_AUTH!=='absent')headers.Cookie='__Host-sk_owner='+(env.ROW_AUTH==='invalid'?'invalid-local-session':env.ROW_TOKEN);
      const path=op==='import/file'?'/review/import':'/review/'+env.ROW_APPROVAL;
      const setup=await dispatch(new Request(origin+path,{headers}));
      const csrf=/name="csrf" value="([^"]+)"/.exec(setup.body)?.[1];
      if(env.ROW_AUTH==='valid'&&!csrf)throw Error('Owner form unavailable');
      const form=new FormData();form.set('csrf',env.ROW_AUTH==='badcsrf'?'wrong-csrf':csrf??'unavailable');
      if(op==='import/file')form.set('file',new File([env.ROW_FILE],'site.json',{type:'application/json'}));
      else form.set('all','approve');
      request=new Request(origin+path,{method:'POST',headers,body:form});
      state=counters(); // All setup work has settled and is explicitly excluded.
    }
    const {response,body}=await dispatch(request);
    return Response.json({status:response.status,headers:[...response.headers].filter(([k])=>allowedHeaders.includes(k.toLowerCase())),bytes:new TextEncoder().encode(body).length,credential_oracle_headers:["set-cookie","retry-after","x-rate-limit-remaining"].some(k=>response.headers.has(k)),counters:state});
  } catch {state.closed=true;return Response.json({error:'Write measurement failed',counters:state},{status:500});}
}};
