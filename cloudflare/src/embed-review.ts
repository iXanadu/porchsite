/** Owner review text only. No player is ever loaded here. */
import { esc } from "./html";
import { embedURL, unicodeHost } from "./embed-url";
import { embedsOf, safeSources } from "./embeds";
type Row = {id:string;kind:string;data:Record<string,any>;deleted?:boolean};
const sources = (rows:Row[]) => safeSources(rows.find(r=>r.kind==='site')?.data.embed_sources);
const count = (rows:Row[], source:string) => rows.filter(r=>r.kind==='entry'&&r.data.status!=='draft').reduce((n,r)=>n+embedsOf(String(r.data.body??'')).filter(e=>e.origin===source).length,0);
function sourceLabel(source:string):string {
  const u=embedURL(source,true), unicode=unicodeHost(u.hostname);
  const display=unicode===u.hostname?source:`https://${unicode}${u.port?':'+u.port:''} (${source})`;
  return `<bdi dir="ltr">${esc(display)}</bdi>`;
}
export function embedReview(live:Row[], proposed:Row[], changes:Row[], origin:string):string {
  const before=sources(live), after=sources(proposed);
  const lines:string[]=[];
  for(const source of [...after.filter(s=>!before.includes(s)),...before.filter(s=>!after.includes(s))]) {
    const added=after.includes(source), name=sourceLabel(source);
    lines.push(`<p class="warn">${added?'Add embed source':'Remove embed source'}: ${name}. Published embeds: ${count(live,source)}; after this approval: ${count(proposed,source)}. ${added?'This lets published pages show anything from this origin in a frame. That site can play sound, use fullscreen and open separate pages; it can see that the visitor came from this site. You are approving the whole source, not one video or tour.':'Its players become normal links.'}</p>`);
  }
  for(const row of changes.filter(r=>r.kind==='entry'&&!r.deleted)) for(const e of embedsOf(String(row.data.body??''))) {
    const status=e.origin===origin?'this source is this site; only a link is allowed':before.includes(e.origin)?'source already approved':after.includes(e.origin)?'source proposed in this approval':'source not approved';
    lines.push(`<p class="meta">Embed: ${esc(e.title)} — <bdi dir="ltr">${esc(e.url)}</bdi>. Source: ${sourceLabel(e.origin)}; ${status}.</p>`);
  }
  return lines.join('');
}
