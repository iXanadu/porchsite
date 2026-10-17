/** Bounded map metadata from one approved reader view; never render page bodies. */
import type {SiteView} from './site';
import {inlineText,mdText} from './agent-markdown';
import {pagePath} from './public-http';
export type MapPage={path:string;title:string;description:string};
export const MAP_HEADERS={'Content-Type':'text/markdown; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",'Link':'</llms.txt>; rel="describedby"'};
export function mapPages(v:SiteView):MapPage[]{
 if(!v.approved_at?.site)return [];
 const pages:MapPage[]=[{path:'/',title:String(v.site.title??''),description:String(v.site.description??'')}];
 if(v.site.archive?.enabled)pages.push({path:'/archive/',title:String(v.site.archive.title),description:''});
 for(const stream of v.site.streams)for(const e of v.entries)if(e.stream===stream.id&&!e.external_url)pages.push({path:String(e.page),title:String(e.title),description:String(e.summary??'')});
 return pages;
}
const field=(value:string,cap:number)=>mdText([...inlineText(value)].slice(0,cap).join(''));
export function mapResponse(pages:Iterable<MapPage>,origin:string):Response{
 const rows:string[]=[],seen=new Set<string>();let count=0;
 for(const page of pages){
  if(seen.has(page.path)||!pagePath(page.path))continue;seen.add(page.path);
  const title=field(page.title,512),description=field(page.description,2048);
  if(!rows.length){rows.push('# '+title,'');if(description)rows.push(description,'');}
  const line=`- [${title}](<${new URL(page.path+'index.md',origin).href}>)${description?': '+description:''}`;
  if(new TextEncoder().encode([...rows,line,''].join('\n')).length>16384)break;
  rows.push(line);if(++count===50)break;
 }
 return new Response(rows.join('\n')+'\n',{headers:MAP_HEADERS});
}
