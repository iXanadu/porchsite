/** Published reader projections only: never staged item or owner routes. */
import * as site from './site';
import {readNFC,readNormalize} from './read-unicode';
import type {SiteView} from './site';
import * as theme from './theme';
import * as themes from './themes';
import {checkSite,checkSiteDeep} from './check';
import {ApiError} from './errors';
import {INSTRUCTIONS,restricted} from './read-keys';
import {archiveFilter} from './archive';
import {markdownDocument,visibleDocumentText} from './agent-markdown';
import {markdownPath,pagePath} from './public-http';

type Principal=Record<string,unknown>;
type Args=Record<string,any>;
type Page={path:string;title:string;changed_at:string};
type Document=Page&{canonical_url:string;markdown:string;text:string;date?:string;tags:string[]};
const encoder=new TextEncoder();
const digest=async(value:unknown)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
const invalid=(message='Invalid published read arguments.'):never=>{throw new ApiError(400,'invalid',message);};
const missing=():never=>{throw new ApiError(404,'not_found','No published page at that address.');};
const scalars=(value:string)=>[...value];
const validText=(value:unknown):value is string=>typeof value==='string'&&!scalars(value).some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;});
const normalize=readNormalize;
const WORD_SPACE=/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;
const trimQuery=(value:string)=>value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,'');
const max=(values:string[])=>values.filter(Boolean).reduce((a,b)=>!a||after(b,a)?b:a,'');
function compare(a:string,b:string){const x=encoder.encode(readNFC(a)),y=encoder.encode(readNFC(b));for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length;}
function originOf(principal:Principal){
 const raw=principal.origin;if(typeof raw!=='string')return invalid('Site origin is unavailable.');
 try{const url=new URL(raw);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return invalid('Site origin is unavailable.');return url.origin;}catch{return invalid('Site origin is unavailable.');}
}
function timestamp(value:unknown):string {
 if(typeof value!=='string')return invalid('Invalid since timestamp.');
 const m=/^([0-9]{4}-[0-9]{2}-[0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?[Zz]$(?![\s\S])/.exec(value);
 if(!m||Number(m[1].slice(0,4))===0||Number(m[4])>60)return invalid('Invalid since timestamp.');
 const second=m[4]==='60'?'59':m[4],base=m[1]+'T'+m[2]+':'+m[3]+':'+second;
 const date=new Date(base+'Z');
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,19)!==base||(m[4]==='60'&&(m[2]!=='23'||m[3]!=='59')))return invalid('Invalid since timestamp.');
 const fraction=(m[5]??'').replace(/0+$/,'');return m[1]+'T'+m[2]+':'+m[3]+':'+m[4]+(fraction?'.'+fraction:'')+'Z';
}
function after(value:string,bound:string){const a=timestamp(value),b=timestamp(bound);if(a.slice(0,19)!==b.slice(0,19))return a.slice(0,19)>b.slice(0,19);const fa=a.slice(19,-1).replace(/^\./,''),fb=b.slice(19,-1).replace(/^\./,''),n=Math.max(fa.length,fb.length);return fa.padEnd(n,'0')>fb.padEnd(n,'0');}
function limitOf(args:Args){const n=args.limit===undefined?20:args.limit;if(typeof n!=='number'||!Number.isInteger(n)||n<1||n>50)return invalid('Limit must be between 1 and 50.');return n;}
function filters(args:Args){
 const stream=args.stream??'',tag=args.tag??'',since=args.since===undefined?'':timestamp(args.since);
 if(typeof stream!=='string'||(args.stream!==undefined&&!/^[a-z][a-z0-9-]{0,29}$(?![\s\S])/.test(stream))||typeof tag!=='string'||(args.tag!==undefined&&!/^[a-z0-9-]{1,30}$(?![\s\S])/.test(tag)))return invalid('Invalid published page filters.');
 return {stream,tag,since};
}
function pathOf(value:unknown):{path:string;base:string} {
 if(!validText(value)||encoder.encode(value).length>2048||!value.startsWith('/')||value.startsWith('//')||/[\\#\x00-\x20\x7f]/.test(value))return invalid('Invalid published page path.');
 const [raw,...queries]=value.split('?');if(queries.length>1||raw.includes('%')||raw.includes(':')||raw.split('/').some(s=>s==='.'||s==='..'))return invalid('Invalid published page path.');
 const base=markdownPath(raw)??raw;
 let query='';if(queries.length){if(base!=='/archive/')return invalid('Invalid archive filters.');const pairs=new URLSearchParams(queries[0]),f=archiveFilter(pairs),out=new URLSearchParams();if((f.tag&&!/^[a-z0-9-]{1,30}$(?![\s\S])/.test(f.tag))||(f.stream&&!/^[a-z][a-z0-9-]{0,29}$(?![\s\S])/.test(f.stream)))return invalid('Invalid archive filters.');if(f.sort!=='date')out.set('sort',f.sort);if(f.stream)out.set('stream',f.stream);if(f.tag)out.set('tag',f.tag);query=out.size?'?'+out.toString():'';}
 return {base,path:base+query};
}
type Cursor={v:number;last:string;filter:string;corpus:string;principal:string};
const encode=(c:Cursor)=>'ag2_'+btoa(JSON.stringify(c)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function cursorOf(value:unknown):Cursor|null {
 if(value===undefined)return null;
 if(typeof value!=='string'||value.length>2048||!/^ag2_[A-Za-z0-9_-]+$(?![\s\S])/.test(value))return invalid('Invalid cursor.');
 try{
  const payload=value.slice(4),c=JSON.parse(atob(payload.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-payload.length%4)%4)));
  if(!c||Array.isArray(c)||Object.keys(c).length!==5||c.v!==1||typeof c.last!=='string'||/[\\%#?\x00-\x20\x7f]/.test(c.last)||!pagePath(c.last)||!['filter','corpus','principal'].every(k=>typeof c[k]==='string'&&/^[a-f0-9]{64}$(?![\s\S])/.test(c[k])))return invalid('Invalid cursor.');
  const ordered={v:1,last:c.last,filter:c.filter,corpus:c.corpus,principal:c.principal};if(encode(ordered)!==value)return invalid('Invalid cursor.');return ordered;
 }catch{return invalid('Invalid cursor.');}
}
async function binding(principal:Principal){return digest(restricted(principal)?['published_read',principal.readKeyId,principal.ownerEpoch]:['writer',principal.clientId??'',principal.client??'']);}

async function snapshot(db:D1Database,principal:Principal){
 const origin=originOf(principal),v=await site.liveView(db);v.now=new Date();
 const t=await themes.load(db,String(v.site.theme)),installed=await db.prepare('SELECT installed_at FROM themes WHERE name=?').bind(String(v.site.theme)).first<string>('installed_at')??'';
 const ids=new Set(v.entries.map(e=>e.id));
 const stamp=await digest([origin,v.site,v.entries,v.cards,v.notes,v.approved_at,v.updated,v.hero_size,Object.fromEntries(Object.entries(v.share_cards??{}).filter(([id])=>ids.has(id))),t,installed]);
 const changed=max([...Object.values(v.approved_at??{}),installed]);
 return {origin,v,t,installed,stamp,changed,at:v.now.getTime(),byPath:new Map(v.entries.map(e=>[e.page,e]))};
}
type Snapshot=Awaited<ReturnType<typeof snapshot>>;
function pathsOf(s:Snapshot):Page[]{
 const {v,t,changed,installed}=s;if(!v.approved_at?.site)return [];
 const pages:Page[]=[{path:'/',title:String(v.site.title),changed_at:changed}];
 if(v.site.archive?.enabled)pages.push({path:'/archive/',title:String(v.site.archive.title),changed_at:changed});
 if(t)for(const stream of theme.streams(v.site)){
  pages.push({path:stream.archive_url,title:stream.title,changed_at:changed});
  for(const tag of new Set<string>(v.entries.filter(e=>e.stream===stream.id).flatMap(e=>e.tags??[])))pages.push({path:stream.archive_url+'tags/'+tag+'/',title:tag,changed_at:changed});
 }
 for(const e of v.entries)if(!e.external_url)pages.push({path:e.page,title:String(e.title),changed_at:max([v.approved_at.site,v.approved_at[e.id]??'',installed])});
 return [...new Map(pages.map(p=>[p.path,p])).values()].sort((a,b)=>compare(a.path,b.path));
}
async function document(s:Snapshot,path:string):Promise<Document|null>{
 const {v,t,origin}=s,{base}=pathOf(path);if(!v.approved_at?.site||!pagePath(base))return null;
 const release=v.updated.replace(/[^0-9A-Za-z]/g,'')||'0',policy={sources:v.site.embed_sources,origin};
 const e=s.byPath.get(base);let html:string|undefined;
 if(base==='/archive/'&&v.site.archive?.enabled)html=await site.allArchivePage(v,archiveFilter(new URL(path,origin).searchParams),origin,!!t).text();
 else if(base==='/')html=t?theme.render(t,'home',theme.homeView(v,release,origin),policy):await site.home(v,origin).text();
 else if(e&&!e.external_url)html=t?theme.render(t,'entry',theme.entryView(v,e,release,origin),policy):await site.entryPage(v,base,origin)!.text();
 else if(t){const match=/^\/([a-z][a-z0-9-]{0,29})\/(?:tags\/([a-z0-9-]{1,30})\/)?$/.exec(base);if(match){const view=theme.archiveView(v,match[1],release,origin,match[2]);if(view)html=theme.render(t,match[2]?'tag':'archive',view,policy);}}
 if(html===undefined)return null;
 const canonical_url=origin+path,doc=markdownDocument(html,canonical_url);
 return {path,canonical_url,title:doc.title,changed_at:e?max([v.approved_at.site,v.approved_at[e.id]??'',s.installed]):s.changed,markdown:doc.markdown,text:visibleDocumentText(html),tags:e?[...e.tags]:[],...(e?{date:String(e.date)}:{})};
}
async function unchanged(db:D1Database,s:Snapshot,principal:Principal){
 // Current helpers observe local date/minute. Never return a mixed-clock corpus.
 const current=await snapshot(db,principal);return Math.floor(Date.now()/60000)===Math.floor(s.at/60000)&&current.stamp===s.stamp;
}
async function corpus(db:D1Database,principal:Principal){
 const s=await snapshot(db,principal),docs:Document[]=[];
 for(const p of pathsOf(s)){const doc=await document(s,p.path);if(doc)docs.push(doc);}
 return {s,docs,generation:await digest(docs.map(d=>[d.path,d.title,d.changed_at,d.text]))};
}
async function pageSlice(db:D1Database,args:Args,principal:Principal,searchQuery?:string){
 const limit=limitOf(args),filter=searchQuery===undefined?filters(args):null,cursor=cursorOf(args.cursor);
 const query=searchQuery===undefined?['pages_list',filter]:['search',searchQuery];
 const filterDigest=await digest(query),principalDigest=await binding(principal);
 if(cursor&&(cursor.filter!==filterDigest||cursor.principal!==principalDigest))return invalid('Invalid cursor.');
 const {s,docs,generation}=await corpus(db,principal);
 if(cursor&&cursor.corpus!==generation)throw new ApiError(409,'cursor_stale','Published pages changed. Start a new listing.');
 let rows=docs;
 if(filter){if(filter.stream||filter.tag||filter.since)rows=docs.filter(d=>{const e=s.byPath.get(d.path);return !!e&&!e.external_url&&(!filter.stream||e.stream===filter.stream)&&(!filter.tag||e.tags.includes(filter.tag))&&(!filter.since||after(d.changed_at,filter.since));});}
 else{const terms=searchQuery!.split(WORD_SPACE);rows=docs.filter(d=>{const text=normalize(d.title+' '+d.text);return terms.every(term=>text.includes(term));});}
 if(cursor&&!rows.some(d=>d.path===cursor.last))return invalid('Invalid cursor.');
 const remaining=cursor?rows.filter(d=>compare(d.path,cursor.last)>0):rows,selected=remaining.slice(0,limit);
 const next_cursor=remaining.length>limit?encode({v:1,last:selected.at(-1)!.path,filter:filterDigest,corpus:generation,principal:principalDigest}):null;
 if(!await unchanged(db,s,principal))throw new ApiError(409,'cursor_stale','Published pages changed. Start a new listing.');
 return {s,selected,next_cursor};
}
export async function pagesList(db:D1Database,args:Args,principal:Principal){const {selected,next_cursor}=await pageSlice(db,args,principal);return {pages:selected.map(({path,title,changed_at})=>({path,title,changed_at})),next_cursor};}
export async function search(db:D1Database,args:Args,principal:Principal){
 if(!validText(args.query))return invalid('Query must contain 1 to 200 Unicode scalar values.');
 const trimmed=trimQuery(args.query),query=normalize(trimmed).split(WORD_SPACE).join(' ');if(scalars(query).length<1||scalars(trimmed).length>200)return invalid('Query must contain 1 to 200 Unicode scalar values.');
 const {selected,next_cursor}=await pageSlice(db,args,principal,query);
 return {results:selected.map(d=>({path:d.path,title:d.title,excerpt:scalars(d.text).slice(0,240).join('')})),next_cursor};
}
export async function pageGet(db:D1Database,args:Args,principal:Principal){
 const {path}=pathOf(args.path);
 for(let attempt=0;attempt<2;attempt++){
  const s=await snapshot(db,principal),doc=await document(s,path);if(!doc)return missing();
  if(await unchanged(db,s,principal)){const {path,canonical_url,title,markdown,tags,date}=doc;return {path,canonical_url,title,...(date?{date}:{}),tags,markdown};}
 }
 throw new ApiError(409,'content_changed','Published pages changed. Try again.');
}
export async function state(db:D1Database,args:Args,principal:Principal={}){
 if(args.full===true||args.ids!==undefined)throw new ApiError(403,'unauthorized','Only the published page listing is available.');
 const {s,selected,next_cursor}=await pageSlice(db,{},principal);
 const read_guide={scope:'published_read',tools:['site_state','site_check','page_get','pages_list','search'],description:INSTRUCTIONS};
 const revision='published-read-'+await digest(read_guide),included=args.guide?.known_revision!==revision;
 return {scope:'published_read',site:{title:s.v.approved_at?.site?String(s.v.site.title):''},pages:selected.map(({path,title,changed_at})=>({path,title,changed_at})),next_cursor,...(included?{read_guide}:{}),...(args.guide!==undefined?{guide:{revision,included}}:{})};
}
export async function check(db:D1Database,args:Args,origin:string){
 const v=await site.liveView(db),text=JSON.stringify(v),all=(await db.prepare('SELECT name FROM media').all<{name:string}>()).results;
 const names=new Set(all.filter(r=>text.includes('/media/'+r.name)).map(r=>r.name));
 return args.deep?checkSiteDeep(v,names,await themes.load(db,String(v.site.theme)),origin):checkSite(v,names);
}
