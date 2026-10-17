/** Inert structured facts from the same visitor projection as the text copy. */
import { markdownDocument } from './agent-markdown';
export function structuredData(html:string,canonical:string):string {
  const doc=markdownDocument(html,canonical),path=new URL(canonical).pathname;
  const collection=/^\/[a-z][a-z0-9-]{0,29}\/(?:tags\/[a-z0-9-]{1,30}\/)?$/.test(path);
  const value:Record<string,string>={'@context':'https://schema.org','@type':collection?'CollectionPage':'WebPage',url:canonical,name:doc.title};
  if(doc.description)value.description=doc.description;
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
export function structuredBlock(html:string,canonical:string):string {
  return `<script type="application/ld+json">${structuredData(html,canonical)}</script>`;
}

/** Engine facts from approved fields; does not parse HTML or expand bodies. */
export function structuredViewBlock(v:import('./site').SiteView,canonical:string):string {
 const path=new URL(canonical).pathname;
 const entry=v.entries.find(e=>e.page===path&&!e.external_url);
 const match=/^\/([a-z][a-z0-9-]{0,29})\/(?:tags\/([a-z0-9-]{1,30})\/)?$/.exec(path);
 const stream=match?(v.site.streams as Record<string,any>[]).find(s=>(s.path||s.id)===match[1]):undefined;
 const archive=path==='/archive/'&&v.site.archive?.enabled;
 const name=entry?entry.title:archive?v.site.archive.title:stream?`${match?.[2]?'#'+match[2]+' · ':''}${stream.title}`:v.site.title;
 const description=entry?entry.summary:archive?'':stream?stream.description:v.site.description;
 const value:Record<string,string>={'@context':'https://schema.org','@type':archive||stream?'CollectionPage':'WebPage',url:canonical,name:String(name??'')};
 if(description)value.description=String(description);
 return `<script type="application/ld+json">${JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))}</script>`;
}
