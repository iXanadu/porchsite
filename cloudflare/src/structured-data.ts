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
