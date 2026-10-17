/** Public representation metadata; called only after the private-site gate. */
import { robots } from './sitemap';
import { archiveFilter } from './archive';
import { noStore } from './privacy';
export const PUBLIC_CACHE = 'public, no-cache, must-revalidate, no-transform';
export const trainingSignal = (disabled: boolean) => `search=yes, ai-input=yes, ai-train=${disabled ? 'no' : 'yes'}`;
export function publicPath(path: string): boolean {
  return path === '/' || path === '/robots.txt' || path === '/sitemap.xml' ||
    /^\/[a-z][a-z0-9-]{0,29}\/(?:[a-z0-9-]{1,80}\/|tags\/[a-z0-9-]{1,30}\/|feed\.xml)?$/.test(path);
}
/** Canonical query identity is needed only for the filtered combined archive. */
export function pageQuery(req:Request,path:string):string {
  if(path!=='/archive/')return '';
  const filters=archiveFilter(new URL(req.url).searchParams),query=new URLSearchParams();
  if(filters.sort!=='date')query.set('sort',filters.sort);
  if(filters.stream)query.set('stream',filters.stream);
  if(filters.tag)query.set('tag',filters.tag);
  return query.size?'?'+query.toString():'';
}
export function sessionRequest(req: Request): boolean {
  return req.headers.has('Authorization') || /(?:^|;\s*)__Host-sk_(?:owner|reader)=/.test(req.headers.get('Cookie') ?? '');
}
export async function trainingDisabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT f.value FROM live l JOIN site_fields f ON f.version = l.version AND f.key = 'ai_training_disabled' AND f.approved = 1 WHERE l.item_id = 'site'").first<{value:string}>();
  return !!row && JSON.parse(row.value) === true;
}
export function matchesTag(value: string | null, tag: string): boolean {
  if (!value) return false;
  value = value.trim();
  if (value === '*') return true;
  if (!/^[ \t]*(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"[ \t]*(?:,[ \t]*(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"[ \t]*)*$/.test(value)) return false;
  return [...value.matchAll(/(?:W\/)?"[^"]*"/g)].some(m => m[0].replace(/^W\//, '') === tag.replace(/^W\//, ''));
}
export async function publicResponse(db: D1Database, req: Request, response: Response): Promise<Response> {
  const url = new URL(req.url), path = url.pathname;
  if (!['GET','HEAD'].includes(req.method) || response.status !== 200 || !(publicPath(path) || path==='/llms.txt' || markdownPath(path))) return response;
  const type = response.headers.get('Content-Type') ?? '';
  if (!['text/markdown; charset=utf-8', 'text/html; charset=utf-8', 'text/plain; charset=utf-8', 'application/atom+xml; charset=utf-8', 'application/xml; charset=utf-8'].includes(type)) return response;
  if (sessionRequest(req)) return noStore(path === '/robots.txt'
    ? new Response(robots(url.origin, await trainingDisabled(db)), response) : response);
  const disabled = await trainingDisabled(db), signal = trainingSignal(disabled);
  const body = path === '/robots.txt' ? robots(url.origin, disabled) : await response.text();
  const input = `${url.origin}${markdownPath(path)??path}${pageQuery(req,markdownPath(path)??path)}\0${type}\0${signal}\0${body}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  const tag = `W/"sha256-${[...digest].map(n=>n.toString(16).padStart(2,'0')).join('')}"`;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', PUBLIC_CACHE); headers.set('Content-Signal', signal); headers.set('ETag', tag);
  headers.delete('Last-Modified'); headers.delete('Content-Length');
  const match = matchesTag(req.headers.get('If-None-Match'), tag);
  return new Response(match ? null : body, { status: match ? 304 : 200, headers });
}

/** Split HTTP lists outside quoted parameter values. */
function splitHeader(value:string,delimiter:string):string[]|null {
  const parts:string[]=[];let start=0,quoted=false,escaped=false;
  for(let i=0;i<value.length;i++) {
    const c=value[i];
    if(escaped){escaped=false;continue;}
    if(quoted&&c==='\\'){escaped=true;continue;}
    if(c==='"'){quoted=!quoted;continue;}
    if(c===delimiter&&!quoted){parts.push(value.slice(start,i));start=i+1;}
  }
  if(quoted||escaped)return null;
  parts.push(value.slice(start));return parts;
}

/** Negotiation is gated here before content even while public twins are pending. */
export function representation(accept: string | null): 'html'|'markdown'|null {
  if (!accept) return 'html';
  const ranges: {type:string;sub:string;q:number;specific:number;usable:boolean}[] = [];
  const parts=splitHeader(accept,',');if(!parts)return 'html';
  for (const part of parts) {
    const fields=splitHeader(part.trim().toLowerCase(),';');if(!fields)return 'html';
    const [name,...params] = fields.map(x=>x.trim());
    const range = /^([a-z0-9!#$%&'*+.^_`|~-]+|\*)\/([a-z0-9!#$%&'*+.^_`|~-]+|\*)$/.exec(name);
    if (!range || (range[1] === '*' && range[2] !== '*')) return 'html';
    let q=1, usable=true, quality=false;
    for (const param of params) {
      const m = /^([a-z0-9!#$%&'*+.^_`|~-]+)=(?:"((?:[^"\\\r\n]|\\.)*)"|([a-z0-9!#$%&'*+.^_`|~-]+))$/.exec(param);
      if (!m) return 'html';
      const value=m[2]!==undefined?m[2].replace(/\\(.)/g,'$1'):m[3];
      if(m[1]==='q') {if(quality || !/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/.test(value))return 'html';q=Number(value);quality=true;}
      else if(m[1]!=='charset' || value!=='utf-8') usable=false;
    }
    ranges.push({type:range[1],sub:range[2],q,specific:range[1]==='*'?0:range[2]==='*'?1:2,usable});
  }
  const score=(sub:string)=>{const matched=ranges.filter(r=>r.usable&&(r.type==='text'||r.type==='*')&&(r.sub===sub||r.sub==='*'));const specificity=Math.max(-1,...matched.map(r=>r.specific));return Math.max(0,...matched.filter(r=>r.specific===specificity).map(r=>r.q));};
  if(score('html')===0 && score('markdown')===0)return null;
  if(ranges.some(r=>r.usable&&r.type==='text'&&r.sub==='markdown') && score('markdown')>0 && score('markdown')>=score('html'))return 'markdown';
  return score('html')>0?'html':null;
}
export const markdownRequested=(accept:string|null)=>representation(accept)==='markdown';
export function pagePath(path:string):boolean {return path==='/' || (publicPath(path)&&path.endsWith('/'));}
export function markdownPath(path:string):string|null {const base=path.endsWith('/index.md')?path.slice(0,-8):null;return base&&pagePath(base)?base:null;}
export function privateAgentPath(req: Request): boolean {
  const path=new URL(req.url).pathname;
  return path==='/llms.txt' || /\/index\.(?:md|jsonld)\/?$/.test(path) ||
    ((path==='/' || (publicPath(path)&&path.endsWith('/'))) && markdownRequested(req.headers.get('Accept')));
}
