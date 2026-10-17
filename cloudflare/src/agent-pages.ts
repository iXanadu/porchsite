/** Public data twins. The caller must run the private-site gate first. */
import { markdownDocument, mdText } from './agent-markdown';
import { markdownPath, pagePath, representation } from './public-http';
type Route=(req:Request)=>Promise<Response>;
const MD={'Content-Type':'text/markdown; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",'Link':'</llms.txt>; rel="describedby"'};
const anonymous=(req:Request,path:string)=>new Request(new URL(path,req.url),{method:'GET'});
const isHTML=(r:Response)=>r.status===200&&r.headers.get('Content-Type')==='text/html; charset=utf-8';
export async function agentPage(req:Request,route:Route,paths:()=>Promise<string[]>,notFound:Route):Promise<Response> {
  const path=new URL(req.url).pathname;
  if(req.method!=='GET')return route(req);
  if(path==='/llms.txt') {
    const rows:string[]=[],seen=new Set<string>();let count=0;
    for(const p of ['/',...await paths()]) {
      if(seen.has(p)||!pagePath(p))continue;seen.add(p);
      const response=await route(anonymous(req,p));if(!isHTML(response))continue;
      const doc=markdownDocument(await response.text(),new URL(p,req.url).href);
      if(!rows.length) {
        const title=[...doc.title].slice(0,512).join(''),description=[...doc.description].slice(0,2048).join('');
        rows.push('# '+mdText(title),'');if(description)rows.push(mdText(description),'');
      }
      const label=mdText([...doc.title].slice(0,512).join(''));
      const summary=mdText([...doc.description].slice(0,2048).join(''));
      const line=`- [${label}](<${new URL(p+'index.md',req.url).href}>)${summary?': '+summary:''}`;
      if(new TextEncoder().encode([...rows,line,''].join('\n')).length>16384)break;
      rows.push(line);if(++count===50)break;
    }
    return new Response(rows.join('\n')+'\n',{headers:MD});
  }
  const base=markdownPath(path);
  if(base || /\/index\.md\/?$/.test(path)) {
    if(!base)return notFound(req);
    const response=await route(anonymous(req,base));
    if(!isHTML(response))return notFound(req);
    return new Response(markdownDocument(await response.text(),new URL(base,req.url).href).markdown,{headers:MD});
  }
  const response=await route(req);
  if(!pagePath(path)||!isHTML(response))return response;
  const selected=representation(req.headers.get('Accept'));
  const headers=new Headers(response.headers);
  const vary=headers.get('Vary');headers.set('Vary',vary?`${vary}, Accept`:'Accept');headers.delete('Content-Length');
  if(selected===null)return new Response(null,{status:406,headers:{'Vary':'Accept','Cache-Control':'private, no-store, no-transform'}});
  if(selected==='markdown') {
    const visitor=await route(anonymous(req,path));
    if(!isHTML(visitor))return visitor;
    return new Response(markdownDocument(await visitor.text(),new URL(path,req.url).href).markdown,{headers:{...MD,Vary:headers.get('Vary')!}});
  }
  const copy=path+'index.md';
  const link=`<${copy}>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"`;
  headers.set('Link',[headers.get('Link'),link].filter(Boolean).join(', '));
  const body=(await response.text()).replace('</head>',`<link rel="alternate" type="text/markdown" href="${copy}"></head>`);
  return new Response(body,{status:200,headers});
}
