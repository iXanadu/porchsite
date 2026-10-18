import {plan as timePlan,valid as timeValid} from './public-time';
import * as publicRead from './public-read';
/** Disposable anonymous copies. The router must run the private gate first. */
import {frameCsp,PERMISSIONS} from './embeds';
import {markdownPath,pagePath,pageQuery,representation,sessionRequest,matchesTag,PUBLIC_CACHE} from './public-http';

/** Legacy fixture encoding; live lookup/admission uses THIN_FORMAT. */
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

const ALLOWED=new Set(['x-internal-body-sha256','content-type','content-security-policy','permissions-policy','x-content-type-options','referrer-policy','link','content-signal','etag','cache-control','vary']);
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
/** A storage age bound, never an input to the public validator. */
export function displayBoundary(now:number,p?:ReturnType<typeof timePlan>){return p?.kind==='unknown'?now:Math.min(now+86400000,p?.next_change??Infinity);}
// Stored metadata is reconstructed/validated against engine policy, never trusted as arbitrary headers.
const HTML_POLICIES=[
 "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
 "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
];
function safeMetadata(headers:Headers,req:Request,c:Choice,f:publicRead.Facts):boolean {
 const md=c.type!=='html',description='</llms.txt>; rel="describedby"';
 if(headers.get('X-Content-Type-Options')!=='nosniff'||(headers.has('Vary')&&headers.get('Vary')!=='Accept'))return false;
 if(headers.get('Link')!==(md?description:`<${c.base}index.md${c.query}>; rel="alternate"; type="text/markdown", ${description}`))return false;
 if(md)return headers.get('Content-Security-Policy')==="default-src 'none'; base-uri 'none'; frame-ancestors 'none'"&&!headers.has('Permissions-Policy')&&!headers.has('Referrer-Policy');
 if(headers.get('Permissions-Policy')!==PERMISSIONS||headers.get('Referrer-Policy')!=='strict-origin-when-cross-origin')return false;
 const sources=f.site.embed_sources;
 if(c.base==='/archive/'&&HTML_POLICIES.some(base=>headers.get('Content-Security-Policy')===base.replace("form-action 'none'","form-action 'self'")))return true;
 return HTML_POLICIES.some(base=>headers.get('Content-Security-Policy')===frameCsp(base,sources,new URL(req.url).origin)||(c.base==='/archive/'&&headers.get('Content-Security-Policy')===frameCsp(base.replace("form-action 'none'","form-action 'self'"),sources,new URL(req.url).origin)));
}
async function delivery(row:{body:string;metadata:string},req:Request,c:Choice,f:publicRead.Facts,etag:string):Promise<Response|null> {
 if(bytes(row.body)>MAX_BODY||bytes(row.metadata)>8192)return null;
 let entries:[string,string][];
 try{entries=JSON.parse(row.metadata);if(!Array.isArray(entries)||entries.some(p=>!Array.isArray(p)||p.length!==2||p.some(x=>typeof x!=='string')||!ALLOWED.has(p[0])))return null;}catch{return null;}
 if(new Set(entries.map(p=>p[0])).size!==entries.length)return null;
 const headers=new Headers(entries);if(!safeMetadata(headers,req,c,f))return null;
 if(headers.get('Content-Type')!==TYPES[c.type]||headers.get('Cache-Control')!==PUBLIC_CACHE||!/^W\/"dep1-[a-f0-9]{64}"$/.test(headers.get('ETag')??'')||!/^search=yes, ai-input=yes, ai-train=(yes|no)$/.test(headers.get('Content-Signal')??''))return null;
 if(headers.get('ETag')!==etag||headers.get('Content-Signal')!==publicRead.headers(f,{...c,type:TYPES[c.type],kind:c.type},etag,new URL(req.url).origin).get('Content-Signal')||headers.get('x-internal-body-sha256')!==await digest(row.body))return null;
 headers.delete('x-internal-body-sha256');
 if(c.type==='html'||(c.type==='markdown'&&!c.direct))headers.set('Vary','Accept');else headers.delete('Vary');
 const match=matchesTag(req.headers.get('If-None-Match'),headers.get('ETag')!);
 return new Response(match||req.method==='HEAD'?null:row.body,{status:match?304:200,headers});
}

export const THIN_FORMAT='public-artifacts/2',MAX_FACTS=128*1024;
export type Proof={facts:publicRead.Facts;choice:publicRead.Choice;tag:string|null;now:number};
// Both relations are engine-shaped raw tuples. Grouped multiplicities prevent
// duplicate tuples from concealing a removed dependency; comparison is atomic
// with row selection/admission, not a fresh-check followed by a separate read.
export function proofSQL(){return `WITH current_facts AS (${publicRead.FACTS_RELATION}),
 expected AS (SELECT json_extract(value,'$[0]') AS category,json_extract(value,'$[1]') AS ident,json_extract(value,'$[2]') AS value FROM json_each(?)),
 current_counts AS MATERIALIZED (SELECT category,ident,value,count(*) AS n FROM current_facts GROUP BY category,ident,value),
 expected_counts AS MATERIALIZED (SELECT category,ident,value,count(*) AS n FROM expected GROUP BY category,ident,value),
 proof AS (SELECT NOT EXISTS(SELECT category,ident,value,n FROM current_counts EXCEPT SELECT category,ident,value,n FROM expected_counts)
 AND NOT EXISTS(SELECT category,ident,value,n FROM expected_counts EXCEPT SELECT category,ident,value,n FROM current_counts)
 AND EXISTS(SELECT 1 FROM public_artifact_state WHERE id=1 AND generation=?) AS ok)`;}
export function lookupSQL(){return `WITH current_facts AS (${publicRead.FACTS_RELATION}),
 expected AS (SELECT json_extract(value,'$[0]') AS category,json_extract(value,'$[1]') AS ident,json_extract(value,'$[2]') AS value FROM json_each(?)),
 current_counts AS MATERIALIZED (SELECT category,ident,value,count(*) AS n FROM current_facts GROUP BY category,ident,value),
 expected_counts AS MATERIALIZED (SELECT category,ident,value,count(*) AS n FROM expected GROUP BY category,ident,value),
 tuple_proof AS (SELECT NOT EXISTS(SELECT category,ident,value,n FROM current_counts EXCEPT SELECT category,ident,value,n FROM expected_counts)
 AND NOT EXISTS(SELECT category,ident,value,n FROM expected_counts EXCEPT SELECT category,ident,value,n FROM current_counts) AS facts_ok),
 copy_state AS MATERIALIZED (SELECT generation,revision FROM public_artifact_state WHERE id=1),
 proof AS (SELECT t.facts_ok,s.generation,s.revision,
 COALESCE(typeof(s.generation)='text' AND typeof(s.revision)='integer' AND t.facts_ok AND s.generation=?,0) AS ok
 FROM tuple_proof t LEFT JOIN copy_state s ON 1=1)
 SELECT p.facts_ok,p.generation,p.revision,p.ok,a.key,a.body,a.metadata,a.valid_until FROM proof p LEFT JOIN public_artifacts a ON p.ok AND a.key=? AND a.generation=?`;}

export function admitSQL(){return proofSQL()+` INSERT OR REPLACE INTO public_artifacts(key,generation,body,metadata,valid_until,size)
 SELECT ?,?,?,?,?,? FROM proof WHERE ok AND ?>((julianday('now')-2440587.5)*86400000)
 AND (SELECT count(*) FROM public_artifacts WHERE key<>?)<?
 AND (SELECT COALESCE(sum(size),0) FROM public_artifacts WHERE key<>?)+?<=?`;}
export async function generation(f:publicRead.Facts,release:string,origin:string){return digest(JSON.stringify([THIN_FORMAT,release,origin,f.rows]));}
async function synchronize(db:D1Database,g:string){await db.batch([db.prepare('INSERT OR IGNORE INTO public_artifact_state(id) VALUES(1)'),db.prepare('DELETE FROM public_artifacts'),db.prepare("UPDATE public_artifact_state SET generation=?,revision=revision+1,preparing='',prepare_until=0 WHERE id=1").bind(g)]);}
export type Render=()=>Promise<Response>;
/** Caller supplies its request-owned public proof, never a cached access grant. */
export async function respond(db:D1Database,req:Request,configured:string|undefined,release:string,render:Render,captured?:Proof,refresh:Render=render):Promise<Response>{
 const origin=configuredOrigin(configured);if(!origin)return render();
 let c:Choice|null;try{c=choice(req,origin);}catch{return render();}if(!c)return render();
 let f:publicRead.Facts,selected:publicRead.Choice,etag:string,raw:string,g:string,key:string,until:number,clock:ReturnType<typeof timePlan>;
 try{
  f=captured?.facts??await publicRead.facts(db,true);
  const picked=captured?.choice??publicRead.choice(req,f);
  if(f.private||!picked||!f.hasSite)return refresh();selected=picked;
  const at=captured?.now??Date.now();clock=timePlan(f,selected,at);
  const tag=captured?captured.tag:await publicRead.tag(f,req,selected,release,at);
  if(!tag||clock.kind==='unknown'||!timeValid(clock))return refresh();etag=tag;
  raw=JSON.stringify(f.raw);if(!f.raw||bytes(raw)>MAX_FACTS)return render();
  g=await generation(f,release,origin);until=displayBoundary(Date.now(),clock);
  key=JSON.stringify([THIN_FORMAT,origin,g,release,c.base+c.query,c.type,etag]);if(bytes(key)>2048)return render();
  const found=(await db.prepare(lookupSQL()).bind(raw,g,key,g).all<any>()).results;
  if(found.length!==1)throw Error('Unavailable copy proof');
  const row=found[0],state=typeof row.generation==='string'&&Number.isInteger(row.revision);
  if(![0,1].includes(row.facts_ok)||![0,1].includes(row.ok)||!Object.hasOwn(row,'generation')||!Object.hasOwn(row,'revision')||row.ok!==Number(!!row.facts_ok&&state&&row.generation===g))throw Error('Unavailable copy proof');
  if(row.key!==null&&row.key!==key)throw Error('Unavailable copy proof');
  if((!row.ok||row.key===null)&&(row.key!==null||row.body!==null||row.metadata!==null||row.valid_until!==null))throw Error('Unavailable copy proof');
  if(!row.facts_ok){await clear(db);return refresh();}
  if(!row.ok){
   // No body is selected on generation/state mismatch. Synchronizing does not
   // authorize admission: the final INSERT still proves all current tuples.
   await synchronize(db,g);
  }else if(row.key){
   if(row.valid_until>Date.now()&&timeValid(clock)){
    const hit=await delivery(row,req,c,f,etag);
    if(hit&&row.valid_until>Date.now()&&timeValid(clock))return hit;
   }
   await db.prepare('DELETE FROM public_artifacts WHERE key=?').bind(key).run();
  }
 }catch{return refresh();}
 const response=await render();
 if(response.status!==200||response.headers.get('Content-Type')!==TYPES[c.type]||response.headers.has('Set-Cookie')||response.headers.get('Cache-Control')!==PUBLIC_CACHE||response.headers.get('ETag')!==etag)return response;
 const body=await response.clone().text(),size=bytes(body),metadata=JSON.stringify([...response.headers].filter(([name])=>ALLOWED.has(name)).concat([['x-internal-body-sha256',await digest(body)]]));
 if(Date.now()>=until||!timeValid(clock))return refresh();
 if(size>MAX_BODY||bytes(metadata)>8192)return response;
 try{
  const inserted=await db.batch([db.prepare('DELETE FROM public_artifacts WHERE valid_until<=?').bind(Date.now()),
   db.prepare(admitSQL()).bind(raw,g,key,g,body,metadata,until,size,until,key,MAX_ROWS,key,size,MAX_BYTES)]);
  if(!inserted[1].meta.changes||!timeValid(clock))return refresh();
 }catch{return refresh();}
 return response;
}

/** Internal public-only work; never a synthetic HTTP visit or analytics event. */
export async function prepare(db:D1Database,configured:string|undefined,release:string,renderPath:(req:Request)=>Promise<Response>,paths:()=>Promise<string[]>):Promise<void>{
 const origin=configuredOrigin(configured);if(!origin)return;
 const {livePrivate}=await import('./privacy');
 if(await livePrivate(db))return;
 const initial=await publicRead.preparationFacts(db);if(initial.private||!initial.hasSite)return;const stamp=JSON.stringify(initial.rows);
 const g=await generation(initial,release,origin);if(initial.generation!==g)await synchronize(db,g);
 const token=crypto.randomUUID(),started=Date.now();
 await db.prepare('INSERT OR IGNORE INTO public_artifact_state(id) VALUES(1)').run();
 const claim=await db.prepare("UPDATE public_artifact_state SET preparing=?,prepare_until=? WHERE id=1 AND (preparing='' OR prepare_until<=?) RETURNING id").bind(token,started+30000,started).first();if(!claim)return;
 try{
  if(await livePrivate(db)||JSON.stringify((await publicRead.facts(db)).rows)!==stamp)return;
  const pages=[...new Set(['/',...await paths()])].filter(p=>pagePath(p)&&!p.includes('?')).slice(0,50);
  const work=['/','/index.md',...(pages.includes('/archive/')?['/archive/','/archive/index.md']:[]),'/llms.txt',...pages.filter(p=>p!=='/'&&p!=='/archive/').flatMap(p=>[p,p+'index.md'])];
  for(const path of work){
   if(Date.now()-started>=250||await livePrivate(db)||JSON.stringify((await publicRead.facts(db)).rows)!==stamp)break;
   const request=new Request(origin+path);
   await respond(db,request,origin,release,()=>renderPath(request));
  }
 }finally{await db.prepare("UPDATE public_artifact_state SET preparing='',prepare_until=0 WHERE id=1 AND preparing=?").bind(token).run();}
}
