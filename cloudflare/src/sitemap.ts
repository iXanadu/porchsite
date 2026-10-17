/** Public discovery from the approved live view; never render Markdown. */
import type {SiteView} from './site';
import {streams} from './theme';
const xml=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export const SITEMAP_HEADERS={'Content-Type':'application/xml; charset=utf-8','Cache-Control':'public, no-cache, must-revalidate, no-transform'};
export const robots=(origin:string, disabled=false)=>`User-agent: *\nAllow: /\n${disabled ? '\n'+['GPTBot','ClaudeBot','Google-Extended'].map(name=>`User-agent: ${name}\nDisallow: /\n`).join('\n') : ''}Sitemap: ${origin}/sitemap.xml\n`;
export function sitemap(v:SiteView,origin:string,archives=true):string {
 const dates=new Map<string,string>();
 for(const [id,at] of Object.entries(v.approved_at??{})){
  const d=new Date(at);if(Number.isFinite(d.getTime()))dates.set(id,d.toISOString().slice(0,10));
 }
 const latest=(ids:string[])=>ids.reduce((a,id)=>{const b=dates.get(id)??'';return b>a?b:a;},'');
 const urls=new Map<string,string>();
 const add=(path:string,date:string)=>{if(!urls.has(path))urls.set(path,date);};
 add('/',latest(['site',...v.entries.map(e=>String(e.id)),...v.cards.map(e=>String(e.id)),...v.notes.map(e=>String(e.id))]));
 for(const e of v.entries)if(!e.external_url)add(String(e.page),dates.get(String(e.id))??'');
 if(v.site.archive?.enabled)add('/archive/',latest(['site',...v.entries.map(e=>String(e.id))]));
 if(archives){
  const groups=new Map<string,typeof v.entries>();
  for(const e of v.entries){const key=String(e.stream);if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(e);}
  for(const stream of streams(v.site)){
   const items=groups.get(String(stream.id))??[],tags=new Map<string,string[]>();
   add(String(stream.archive_url),latest(['site',...items.map(e=>String(e.id))]));
   for(const e of items)for(const tag of e.tags??[]){if(!tags.has(tag))tags.set(tag,[]);tags.get(tag)!.push(String(e.id));}
   for(const tag of [...tags.keys()].sort())add(`${stream.archive_url}tags/${tag}/`,latest(['site',...tags.get(tag)!]));
  }
 }
 return '<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+[...urls].map(([path,date])=>`<url><loc>${xml(origin+path)}</loc>${date?`<lastmod>${date}</lastmod>`:''}</url>\n`).join('')+'</urlset>\n';
}
