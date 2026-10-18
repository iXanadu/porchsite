/** Public data twins. The caller must run the private-site gate first. */
import { structuredBlock,structuredViewBlock } from './structured-data';
import { markdownDocument } from './agent-markdown';
import { markdownPath, pagePath, pageQuery, representation, sessionRequest } from './public-http';
type Route=(req:Request)=>Promise<Response>;
const MD={'Content-Type':'text/markdown; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",'Link':'</llms.txt>; rel="describedby"'};
const anonymous=(req:Request,path:string,preserveQuery=false)=>{const url=new URL(path,req.url);if(preserveQuery&&path==='/archive/')url.search=new URL(req.url).search;return new Request(url,{method:'GET'});};
const isHTML=(r:Response)=>r.status===200&&r.headers.get('Content-Type')==='text/html; charset=utf-8';
export async function agentPage(req:Request,route:Route,map:()=>Promise<Response>,notFound:Route,view?:()=>Promise<import('./site').SiteView>):Promise<Response> {
  const path=new URL(req.url).pathname;
  if(req.method!=='GET')return route(req);
  if(path==='/llms.txt')return map();
  const base=markdownPath(path);
  if(base || /\/index\.md\/?$/.test(path)) {
    if(!base)return notFound(req);
    const response=await route(anonymous(req,base,true));
    if(base==='/archive/'&&response.status===400)return response;
    if(!isHTML(response))return notFound(req);
    return new Response(markdownDocument(await response.text(),new URL(base+pageQuery(req,base),req.url).href).markdown,{headers:MD});
  }
  const selected=pagePath(path)?representation(req.headers.get('Accept')):'html';
  const anonymousMarkdown=selected==='markdown'&&!sessionRequest(req);
  const response=await route(anonymousMarkdown?anonymous(req,path,true):req);
  if(!pagePath(path)||!isHTML(response))return response;
  const headers=new Headers(response.headers);
  const vary=headers.get('Vary');headers.set('Vary',vary?`${vary}, Accept`:'Accept');headers.delete('Content-Length');
  if(selected===null)return new Response(null,{status:406,headers:{'Vary':'Accept','Cache-Control':'private, no-store, no-transform'}});
  if(selected==='markdown') {
    const visitor=anonymousMarkdown?response:await route(anonymous(req,path,true));
    if(!isHTML(visitor))return visitor;
    return new Response(markdownDocument(await visitor.text(),new URL(path+pageQuery(req,path),req.url).href).markdown,{headers:{...MD,Vary:headers.get('Vary')!}});
  }
  const copy=path+'index.md'+pageQuery(req,path);
  const link=`<${copy}>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"`;
  headers.set('Link',[headers.get('Link'),link].filter(Boolean).join(', '));
  let original=await response.text();
  if(path==='/archive/'){const canonical=new URL(path+pageQuery(req,path),req.url).href.replace(/&/g,'&amp;');original=original.replace(/<link rel="canonical" href="[^"]*">/,`<link rel="canonical" href="${canonical}">`);}
  let visitorHTML=original;
  if(!view&&sessionRequest(req)){const visitor=await route(anonymous(req,path,true));if(!isHTML(visitor))return visitor;visitorHTML=await visitor.text();}
  const canonical=new URL(path+pageQuery(req,path),req.url).href;
  const data=view?structuredViewBlock(await view(),canonical):structuredBlock(visitorHTML,canonical);
  const body=original.replace('</head>',`${data}<link rel="alternate" type="text/markdown" href="${copy.replace(/&/g,'&amp;')}"></head>`);
  return new Response(body,{status:200,headers});
}
