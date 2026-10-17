/** Public representation metadata; called only after the private-site gate. */
import { robots } from './sitemap';
import { noStore } from './privacy';
export const PUBLIC_CACHE = 'public, no-cache, must-revalidate, no-transform';
export const trainingSignal = (disabled: boolean) => `search=yes, ai-input=yes, ai-train=${disabled ? 'no' : 'yes'}`;
export function publicPath(path: string): boolean {
  return path === '/' || path === '/robots.txt' || path === '/sitemap.xml' ||
    /^\/[a-z][a-z0-9-]{0,29}\/(?:[a-z0-9-]{1,80}\/|tags\/[a-z0-9-]{1,30}\/|feed\.xml)?$/.test(path);
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
  if (!['GET','HEAD'].includes(req.method) || response.status !== 200 || !publicPath(path)) return response;
  const type = response.headers.get('Content-Type') ?? '';
  if (!['text/html; charset=utf-8', 'text/plain; charset=utf-8', 'application/atom+xml; charset=utf-8', 'application/xml; charset=utf-8'].includes(type)) return response;
  if (sessionRequest(req)) return noStore(path === '/robots.txt'
    ? new Response(robots(url.origin, await trainingDisabled(db)), response) : response);
  const disabled = await trainingDisabled(db), signal = trainingSignal(disabled);
  const body = path === '/robots.txt' ? robots(url.origin, disabled) : await response.text();
  const input = `${url.origin}${path}\0${type}\0${signal}\0${body}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  const tag = `W/"sha256-${[...digest].map(n=>n.toString(16).padStart(2,'0')).join('')}"`;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', PUBLIC_CACHE); headers.set('Content-Signal', signal); headers.set('ETag', tag);
  headers.delete('Last-Modified'); headers.delete('Content-Length');
  const match = matchesTag(req.headers.get('If-None-Match'), tag);
  return new Response(match ? null : body, { status: match ? 304 : 200, headers });
}

/** Negotiation is gated here before content even while public twins are pending. */
export function markdownRequested(accept: string | null): boolean {
  if (!accept) return false;
  const ranges: {type:string;sub:string;q:number;specific:number;usable:boolean}[] = [];
  for (const part of accept.split(',')) {
    const [name,...params] = part.trim().toLowerCase().split(';').map(x=>x.trim());
    const range = /^([a-z0-9!#$%&'*+.^_`|~-]+|\*)\/([a-z0-9!#$%&'*+.^_`|~-]+|\*)$/.exec(name);
    if (!range || (range[1] === '*' && range[2] !== '*')) return false;
    let q=1, usable=true, quality=false;
    for (const param of params) {
      const m = /^([a-z0-9!#$%&'*+.^_`|~-]+)=(?:"([^"\r\n]*)"|([a-z0-9!#$%&'*+.^_`|~-]+))$/.exec(param);
      if (!m) return false;
      const value=m[2]??m[3];
      if(m[1]==='q') {if(quality || !/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/.test(value))return false;q=Number(value);quality=true;}
      else if(m[1]!=='charset' || value!=='utf-8') usable=false;
    }
    ranges.push({type:range[1],sub:range[2],q,specific:range[1]==='*'?0:range[2]==='*'?1:2,usable});
  }
  const score=(sub:string)=>{const matched=ranges.filter(r=>r.usable&&(r.type==='text'||r.type==='*')&&(r.sub===sub||r.sub==='*'));const specificity=Math.max(-1,...matched.map(r=>r.specific));return Math.max(0,...matched.filter(r=>r.specific===specificity).map(r=>r.q));};
  return ranges.some(r=>r.usable&&r.type==='text'&&r.sub==='markdown') && score('markdown')>0 && score('markdown')>=score('html');
}
export function privateAgentPath(req: Request): boolean {
  const path=new URL(req.url).pathname;
  return path==='/llms.txt' || /\/index\.(?:md|jsonld)\/?$/.test(path) ||
    ((path==='/' || (publicPath(path)&&path.endsWith('/'))) && markdownRequested(req.headers.get('Accept')));
}
