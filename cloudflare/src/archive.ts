/** The engine's combined archive. No bodies, scripts, or draft lookups. */
import type { SiteView } from './site';
import { html, raw, type Raw } from './html';
import { ApiError } from './errors';
export interface ArchiveFilter { sort: string; tag: string; stream: string }
export function archiveFilter(pairs: Iterable<[string,string]>): ArchiveFilter {
  const out: ArchiveFilter = {sort:'date',tag:'',stream:''};
  const seen = new Set<string>();
  for (const [key,value] of pairs) {
    if (!['sort','tag','stream'].includes(key) || seen.has(key)) throw new ApiError(400,'invalid','Invalid archive filters.');
    seen.add(key);
    if (key === 'sort') { if(value && !['date','stream'].includes(value)) throw new ApiError(400,'invalid','Invalid archive filters.'); out.sort=value || 'date'; }
    // Unlike $, this end assertion cannot match before a final line break.
    if (key === 'tag') { if(value && !/^[a-z0-9-]{1,30}(?![\s\S])/.test(value)) throw new ApiError(400,'invalid','Invalid archive filters.'); out.tag=value; }
    if (key === 'stream') { if(value && !/^[a-z][a-z0-9-]{0,29}(?![\s\S])/.test(value)) throw new ApiError(400,'invalid','Invalid archive filters.'); out.stream=value; }
  }
  return out;
}
export function archiveMain(v: SiteView, filter: ArchiveFilter, streamArchives = true): Raw {
  const streams = v.site.streams as Record<string,any>[];
  const tags = new Map<string,number>();
  for (const e of v.entries) for (const tag of new Set<string>(e.tags ?? [])) tags.set(tag,(tags.get(tag) ?? 0)+1);
  const option = (value:string,label:string,current:string) => html`<option value="${value}"${raw(value===current?' selected':'')}>${label}</option>`;
  const streamOptions=streams.map(s=>option(s.id,s.title,filter.stream));
  if(filter.stream && !streams.some(s=>s.id===filter.stream)) streamOptions.push(option(filter.stream,filter.stream,filter.stream));
  const tagOptions=[...tags.keys()].sort().map(t=>option(t,`${t} (${tags.get(t)})`,filter.tag));
  if(filter.tag && !tags.has(filter.tag)) tagOptions.push(option(filter.tag,`${filter.tag} (0)`,filter.tag));
  let entries=v.entries.filter(e=>(!filter.stream || e.stream===filter.stream) && (!filter.tag || (e.tags??[]).includes(filter.tag)));
  if(filter.sort==='stream') entries=[...entries].sort((a,b)=>streams.findIndex(s=>s.id===a.stream)-streams.findIndex(s=>s.id===b.stream));
  const rows: Raw[]=[]; let previous='';
  for(const e of entries){
    const stream=streams.find(s=>s.id===e.stream)!;
    if(filter.sort==='stream' && previous!==stream.id) rows.push(html`<h2>${stream.title}</h2>`);
    previous=stream.id;
    const streamUrl = streamArchives ? `/${stream.path || stream.id}/` : `/archive/?stream=${stream.id}`;
    rows.push(html`<article class="entry"><p class="meta"><time datetime="${e.date}">${e.date}</time> · <a href="${streamUrl}">${stream.title}</a></p><h3><a href="${e.url}">${e.title}</a></h3>${e.summary?html`<p>${e.summary}</p>`:''}${(e.tags??[]).length?html`<p class="meta">${e.tags.map((t:string)=>html`<span>#${t}</span> `)}</p>`:''}</article>`);
  }
  return html`<style>.archive-filters{display:flex;flex-wrap:wrap;gap:12px;align-items:end}.archive-filters label{display:block;min-width:0;max-width:100%}.archive-filters select{display:block;max-width:100%;font:inherit}.entry{overflow-wrap:anywhere}</style><p><a href="/">Home</a></p><h1>${v.site.archive.title}</h1><form class="archive-filters" method="get" action="/archive/"><label>Order<select name="sort">${option('date','By date',filter.sort)}${option('stream','By stream',filter.sort)}</select></label><label>Stream<select name="stream">${option('','All streams',filter.stream)}${streamOptions}</select></label><label>Tag<select name="tag">${option('','All tags',filter.tag)}${tagOptions}</select></label><button type="submit">Apply</button></form>${rows.length?rows:html`<p>No entries match.</p>`}`;
}
