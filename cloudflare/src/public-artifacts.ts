/** Disposable anonymous copies. The router must run the private gate first. */
import {frameCsp,PERMISSIONS} from './embeds';
import {markdownPath,pagePath,pageQuery,representation,sessionRequest,matchesTag,PUBLIC_CACHE} from './public-http';

export const FORMAT='public-artifacts/1';
export const MAX_BODY=256*1024, MAX_ROWS=128, MAX_BYTES=4*1024*1024;
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const hex=(value:ArrayBuffer)=>[...new Uint8Array(value)].map(x=>x.toString(16).padStart(2,'0')).join('');
export async function digest(value:string){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));}
/** These values have immutable version references or content-addressed digests. */
const QUERIES=[
 "SELECT l.item_id,l.kind,l.slug,l.version,l.published_at,i.created_at FROM live l LEFT JOIN items i ON i.id=l.item_id ORDER BY l.item_id",
 "SELECT f.key,f.value,f.approved FROM site_fields f JOIN live l ON l.version=f.version AND l.item_id='site' ORDER BY f.key",
 "SELECT f.sources,f.approved FROM site_embed_sources f JOIN live l ON l.version=f.version AND l.item_id='site'",
 "SELECT f.settings,f.approved FROM site_stream_settings f JOIN live l ON l.version=f.version AND l.item_id='site'",
 "SELECT a.version FROM private_approvals a JOIN live l ON l.version=a.version AND l.item_id='site'",
 "SELECT a.version FROM training_approvals a JOIN live l ON l.version=a.version AND l.item_id='site'",
 "SELECT name,version,sha256 FROM themes WHERE name=(SELECT CASE json_extract(data,'$.theme') WHEN 'classic' THEN 'personal-homepage' WHEN 'broadsheet' THEN 'product-page' ELSE COALESCE(json_extract(data,'$.theme'),'personal-homepage') END FROM live WHERE item_id='site') ORDER BY name",
 "SELECT c.item_id,c.version,c.name FROM share_cards c JOIN live l ON l.item_id=c.item_id AND l.version=c.version ORDER BY c.item_id",
 "SELECT m.name,m.width,m.height FROM media m WHERE EXISTS (SELECT 1 FROM live l WHERE instr(l.data,'/media/'||m.name)>0) ORDER BY m.name",
];
const COLUMNS=[['item_id','kind','slug','version','published_at','created_at'],['key','value','approved'],['sources','approved'],['settings','approved'],['version'],['version'],['name','version','sha256'],['item_id','version','name'],['name','width','height']];
// One SQL statement observes all rendering dependencies in one database snapshot.
export const SNAPSHOT='json_array('+QUERIES.map((q,i)=>`(SELECT json_group_array(json_array(${COLUMNS[i].join(',')})) FROM (${q}))`).join(',')+')';
/** Embedded JSON is data: database escape/whitespace choices are not dependencies. */
export function normalizedState(stamp:string):unknown[] {
 const state=JSON.parse(stamp);
 for(const [table,column] of [[1,1],[2,0],[3,0]])for(const row of state[table])row[column]=JSON.parse(row[column]);
 const ordered=(value:any):any=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
 return ordered(state);
}
export async function snapshot(db:D1Database){return (await db.prepare(`SELECT ${SNAPSHOT} AS stamp`).first<string>('stamp'))!;}
export function invalidation(db:D1Database):D1PreparedStatement[]{return [db.prepare('DELETE FROM public_artifacts'),db.prepare("UPDATE public_artifact_state SET generation='',revision=revision+1,preparing='',prepare_until=0 WHERE id=1")];}
export async function clear(db:D1Database){await db.batch(invalidation(db));}

const ALLOWED=new Set(['content-type','content-security-policy','permissions-policy','x-content-type-options','referrer-policy','link','content-signal','etag','cache-control','vary']);
const TYPES={'html':'text/html; charset=utf-8','markdown':'text/markdown; charset=utf-8','map':'text/markdown; charset=utf-8'};
type Choice={type:keyof typeof TYPES;base:string;query:string;direct:boolean};
function choice(req:Request,origin:string):Choice|null {
 const url=new URL(req.url);
 if(!['GET','HEAD'].includes(req.method)||sessionRequest(req)||url.origin!==origin)return null;
 if(url.pathname==='/llms.txt')return {type:'map',base:'/llms.txt',query:'',direct:true};
 const md=markdownPath(url.pathname),base=md??url.pathname;
 if(!pagePath(base))return null;
 const selected=md?'markdown':representation(req.headers.get('Accept'));if(!selected)return null;
 return {type:selected,base,query:pageQuery(req,base),direct:!!md};
}
export function configuredOrigin(value:string|undefined):string|null {
 if(!value||!/^https?:\/\/[^/?#]+\/?$/.test(value))return null;
 try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash?url.origin:null;}catch{return null;}
}
/** All current display-clock helpers observe local date/minute only. */
export function displayBoundary(now:number){return (Math.floor(now/60000)+1)*60000;}
// Stored metadata is reconstructed/validated against engine policy, never trusted as arbitrary headers.
const HTML_POLICIES=[
 "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
 "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
];
function safeMetadata(headers:Headers,req:Request,c:Choice,stamp:string):boolean {
 const md=c.type!=='html',description='</llms.txt>; rel="describedby"';
 if(headers.get('X-Content-Type-Options')!=='nosniff'||(headers.has('Vary')&&headers.get('Vary')!=='Accept'))return false;
 if(headers.get('Link')!==(md?description:`<${c.base}index.md${c.query}>; rel="alternate"; type="text/markdown", ${description}`))return false;
 if(md)return headers.get('Content-Security-Policy')==="default-src 'none'; base-uri 'none'; frame-ancestors 'none'"&&!headers.has('Permissions-Policy')&&!headers.has('Referrer-Policy');
 if(headers.get('Permissions-Policy')!==PERMISSIONS||headers.get('Referrer-Policy')!=='strict-origin-when-cross-origin')return false;
 const state=normalizedState(stamp) as any[],sources=state[2][0]?.[1]===1?state[2][0][0]:[];
 if(c.base==='/archive/'&&HTML_POLICIES.some(base=>headers.get('Content-Security-Policy')===base.replace("form-action 'none'","form-action 'self'")))return true;
 return HTML_POLICIES.some(base=>headers.get('Content-Security-Policy')===frameCsp(base,sources,new URL(req.url).origin)||(c.base==='/archive/'&&headers.get('Content-Security-Policy')===frameCsp(base.replace("form-action 'none'","form-action 'self'"),sources,new URL(req.url).origin)));
}
async function delivery(row:{body:string;metadata:string},req:Request,c:Choice,stamp:string):Promise<Response|null> {
 if(bytes(row.body)>MAX_BODY||bytes(row.metadata)>8192)return null;
 let entries:[string,string][];
 try{entries=JSON.parse(row.metadata);if(!Array.isArray(entries)||entries.some(p=>!Array.isArray(p)||p.length!==2||p.some(x=>typeof x!=='string')||!ALLOWED.has(p[0])))return null;}catch{return null;}
 if(new Set(entries.map(p=>p[0])).size!==entries.length)return null;
 const headers=new Headers(entries);if(!safeMetadata(headers,req,c,stamp))return null;
 if(headers.get('Content-Type')!==TYPES[c.type]||headers.get('Cache-Control')!==PUBLIC_CACHE||!/^W\/"sha256-[a-f0-9]{64}"$/.test(headers.get('ETag')??'')||!/^search=yes, ai-input=yes, ai-train=(yes|no)$/.test(headers.get('Content-Signal')??''))return null;
 const expected=`W/\"sha256-${await digest(`${new URL(req.url).origin}${c.base}${c.query}\0${TYPES[c.type]}\0${headers.get('Content-Signal')}\0${row.body}`)}\"`;
 if(headers.get('ETag')!==expected)return null;
 if(c.type==='html'||(c.type==='markdown'&&!c.direct))headers.set('Vary','Accept');else headers.delete('Vary');
 const match=matchesTag(req.headers.get('If-None-Match'),headers.get('ETag')!);
 return new Response(match||req.method==='HEAD'?null:row.body,{status:match?304:200,headers});
}

export type Render=()=>Promise<Response>;
/** No authorization decision is recovered from the derived state row. */
export async function respond(db:D1Database,req:Request,configured:string|undefined,release:string,render:Render):Promise<Response>{
 const origin=configuredOrigin(configured);if(!origin)return render();
 let c:Choice|null;try{c=choice(req,origin);}catch{return render();}if(!c)return render();
 let stamp:string,g:string,key:string,until:number;
 try{
  stamp=await snapshot(db);if(!JSON.parse(stamp)[0].some((r:unknown[])=>r[0]==='site'))return render();g=await digest(JSON.stringify([FORMAT,release,origin,normalizedState(stamp)]));
  until=displayBoundary(Date.now());key=JSON.stringify([origin,g,release,c.base+c.query,c.type,until]);if(bytes(key)>2048)return render();
  const observed=await db.prepare('SELECT generation FROM public_artifact_state WHERE id=1').first<string>('generation');
  if(observed!==g)await db.batch([db.prepare('INSERT OR IGNORE INTO public_artifact_state(id) VALUES(1)'),
   db.prepare('DELETE FROM public_artifacts'),
   db.prepare('UPDATE public_artifact_state SET generation=?,revision=revision+1 WHERE id=1').bind(g)]);
  const row=await db.prepare('SELECT body,metadata,valid_until FROM public_artifacts WHERE key=? AND generation=?').bind(key,g).first<{body:string;metadata:string;valid_until:number}>();
  if(row&&row.valid_until>Date.now()){
   const current=await snapshot(db);
   if(current===stamp){const hit=await delivery(row,req,c,stamp);if(hit&&row.valid_until>Date.now()&&await snapshot(db)===stamp)return hit;}
   await db.prepare('DELETE FROM public_artifacts WHERE key=?').bind(key).run();
  }
 }catch{return render();}
 const response=await render();
 if(response.status!==200||response.headers.get('Content-Type')!==TYPES[c.type]||response.headers.has('Set-Cookie')||response.headers.get('Cache-Control')!==PUBLIC_CACHE)return response;
 const body=await response.clone().text(),size=bytes(body),metadata=JSON.stringify([...response.headers].filter(([name])=>ALLOWED.has(name)));
 if(size>MAX_BODY||bytes(metadata)>8192||Date.now()>=until)return response;
 try{
  // The fingerprint comparison is inside INSERT SELECT, not a check-then-write gap.
  await db.batch([db.prepare('DELETE FROM public_artifacts WHERE valid_until<=?').bind(Date.now()),
   db.prepare(`INSERT OR REPLACE INTO public_artifacts(key,generation,body,metadata,valid_until,size)
    SELECT ?,?,?,?,?,? WHERE (${SNAPSHOT})=? AND EXISTS(SELECT 1 FROM public_artifact_state WHERE id=1 AND generation=?)
    AND ?>((julianday('now')-2440587.5)*86400000)
    AND (SELECT count(*) FROM public_artifacts WHERE key<>?)<?
    AND (SELECT COALESCE(sum(size),0) FROM public_artifacts WHERE key<>?)+?<=?`).bind(key,g,body,metadata,until,size,stamp,g,until,key,MAX_ROWS,key,size,MAX_BYTES)]);
  // An in-flight render cannot be delivered as an old artifact after a change.
  if(await snapshot(db)!==stamp)return render();
 }catch{return render(); /* Re-run the live gate rather than deliver an unverified in-flight body. */}
 return response;
}

/** Internal public-only work; never a synthetic HTTP visit or analytics event. */
export async function prepare(db:D1Database,configured:string|undefined,release:string,renderPath:(req:Request)=>Promise<Response>,paths:()=>Promise<string[]>):Promise<void>{
 const origin=configuredOrigin(configured);if(!origin)return;
 const {livePrivate}=await import('./privacy');
 if(await livePrivate(db))return;
 const state=await db.prepare('SELECT generation FROM public_artifact_state WHERE id=1').first<string>('generation');
 if(state)return; // Only successful invalidation schedules build-ahead.
 const stamp=await snapshot(db);if(!JSON.parse(stamp)[0].some((r:unknown[])=>r[0]==='site'))return;
 const token=crypto.randomUUID(),started=Date.now();
 await db.prepare('INSERT OR IGNORE INTO public_artifact_state(id) VALUES(1)').run();
 const claim=await db.prepare("UPDATE public_artifact_state SET preparing=?,prepare_until=? WHERE id=1 AND generation='' AND (preparing='' OR prepare_until<=?) RETURNING id").bind(token,started+30000,started).first();if(!claim)return;
 try{
  if(await livePrivate(db)||await snapshot(db)!==stamp)return;
  const pages=[...new Set(['/',...await paths()])].filter(p=>pagePath(p)&&!p.includes('?')).slice(0,50);
  const work=['/','/index.md',...(pages.includes('/archive/')?['/archive/','/archive/index.md']:[]),'/llms.txt',...pages.filter(p=>p!=='/'&&p!=='/archive/').flatMap(p=>[p,p+'index.md'])];
  for(const path of work){
   if(Date.now()-started>=250||Date.now()>=displayBoundary(started)||await livePrivate(db)||await snapshot(db)!==stamp)break;
   const request=new Request(origin+path);
   await respond(db,request,origin,release,()=>renderPath(request));
  }
 }finally{await db.prepare("UPDATE public_artifact_state SET preparing='',prepare_until=0 WHERE id=1 AND preparing=?").bind(token).run();}
}
