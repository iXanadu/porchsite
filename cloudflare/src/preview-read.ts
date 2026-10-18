import {dailyAccess} from './daily-limit';
/** Same-principal inspection only. No owner wrapper, stored graph or HTTP grant. */
import {ApiError} from './errors';
import {esc} from './html';
import {parseDocument,markdownDocument} from './agent-markdown';
import {validate} from './content';
import * as site from './site';
import * as theme from './theme';
import {THEMES} from './themes.gen';
import {ALIASES,type Theme} from './themes';
import {schema as streamSchema} from './stream-settings';
import {plan,valid} from './public-time';
import type {Facts,Choice} from './public-read';
import {LOCAL,size as headerSize} from './media';
import {dateString,dateFormatter} from './date-format';
export const NOTICE='Preview: not published.',MAX_BODY=256*1024,MAX_ENVELOPE=320*1024;
const bytes=(s:string)=>new TextEncoder().encode(s).length;
const unavailable=():never=>{throw new ApiError(409,'preview_unavailable','The proposed page cannot be inspected.');};
const changed=():never=>{throw new ApiError(409,'content_changed','The proposed page changed. Request a new preview.');};
const invalid=():never=>{throw new ApiError(422,'invalid','Invalid preview arguments.');};
export type Authority={principal:string;epoch:number};
export type Context={origin:string;siteOrigin?:string;release?:string;authorize:()=>Promise<Authority>};
type Row={category:string;ident:string;value:string};
// One statement pins approval, revisions and every source consumed by this view.
// A broad share-card relation is conservative; no unrelated staged data is read.
export const SNAPSHOT_SQL=`WITH a AS (SELECT id,items,status FROM approvals WHERE id=?),
 m AS (SELECT json_extract(value,'$.id') id,json_extract(value,'$.version') version FROM a,json_each(a.items)),
 chosen AS (SELECT r.data,r.version FROM revisions r JOIN m ON m.id=r.item_id AND m.version=r.version WHERE r.item_id='site' AND r.deleted=0
 UNION ALL SELECT data,version FROM live WHERE item_id='site' AND NOT EXISTS(SELECT 1 FROM m WHERE id='site')),
 versions AS (SELECT version FROM chosen UNION SELECT version FROM live WHERE item_id='site'),
 parts0(category,ident,value) AS MATERIALIZED (
 SELECT 'approval',id,json_array(items,status) FROM a
 UNION ALL SELECT 'item',i.id,json_array(i.kind,i.slug,i.version,i.deleted,i.created_at) FROM items i JOIN m ON m.id=i.id
 UNION ALL SELECT 'revision',r.item_id,json_array(r.version,r.data,r.deleted) FROM revisions r JOIN m ON m.id=r.item_id AND m.version=r.version
), parts1(category,ident,value) AS MATERIALIZED (
 SELECT 'live',l.item_id,json_array(l.kind,l.slug,l.version,l.data,l.published_at,i.created_at) FROM live l LEFT JOIN items i ON i.id=l.item_id
 UNION ALL SELECT 'field',CAST(version AS TEXT)||':'||key,json_array(version,key,value,approved) FROM site_fields WHERE version IN versions
 UNION ALL SELECT 'embed',CAST(version AS TEXT),json_array(version,sources,approved) FROM site_embed_sources WHERE version IN versions
), parts2(category,ident,value) AS MATERIALIZED (
 SELECT 'streams',CAST(version AS TEXT),json_array(version,settings,approved) FROM site_stream_settings WHERE version IN versions
 UNION ALL SELECT 'private',CAST(version AS TEXT),json_array(version) FROM private_approvals WHERE version IN versions
 UNION ALL SELECT 'training',CAST(version AS TEXT),json_array(version) FROM training_approvals WHERE version IN versions
), parts3(category,ident,value) AS MATERIALIZED (
 SELECT 'theme',name,json_array(version,sha256,package) FROM themes WHERE name=(SELECT CASE json_extract(data,'$.theme') WHEN 'classic' THEN 'personal-homepage' WHEN 'broadsheet' THEN 'product-page' ELSE COALESCE(json_extract(data,'$.theme'),'built-in') END FROM chosen)
 UNION ALL SELECT 'media',name,json_array(width,height) FROM media WHERE name=(SELECT substr(json_extract(data,'$.hero'),8) FROM chosen)
 UNION ALL SELECT 'header',c.name,json_array(hex(substr(c.data,1,65536))) FROM media_chunks c JOIN media i ON i.name=c.name WHERE c.n=0 AND i.width=0 AND c.name=(SELECT substr(json_extract(data,'$.hero'),8) FROM chosen)
), parts4(category,ident,value) AS MATERIALIZED (
 SELECT 'share',item_id,json_array(version,name) FROM share_cards
), combined AS MATERIALIZED (SELECT * FROM parts0 UNION ALL SELECT * FROM parts1 UNION ALL SELECT * FROM parts2), facts AS (SELECT * FROM combined UNION ALL SELECT * FROM parts3 UNION ALL SELECT * FROM parts4) SELECT category,ident,value FROM facts ORDER BY category,ident`;
export async function capture(db:D1Database,id:string){return dailyAccess(async()=>(await db.prepare(SNAPSHOT_SQL).bind(id).all<Row>()).results.map(r=>[r.category,r.ident,JSON.parse(r.value)] as [string,string,any[]]));}
type Snapshot=Awaited<ReturnType<typeof capture>>;
function logical(data:Record<string,any>,version:number,live:boolean,rows:Snapshot){
 const at=(kind:string)=>rows.find(r=>r[0]===kind&&r[2][0]===version)?.[2];
 const out:Record<string,any>={...data,broker:'',private:false,ai_training_disabled:false};
 for(const [, ,v]of rows.filter(r=>r[0]==='field'&&r[2][0]===version))if(!live||v[3]){
  if(v[1]==='broker')out.broker=JSON.parse(v[2]);
  if(v[1]==='private')out.private=JSON.parse(v[2])===true&&(!live||!!at('private'));
  if(v[1]==='ai_training_disabled')out.ai_training_disabled=JSON.parse(v[2])===true&&(!live||!!at('training'));
 }
 const streams=at('streams');if(streams&&(!live||streams[2]))Object.assign(out,streamSchema.parse(JSON.parse(streams[1])));
 const embed=at('embed');out.embed_sources=embed?(!live||embed[2]?JSON.parse(embed[1]):[]):data.embed_sources??[];
 return validate('site',out);
}
export function view(rows:Snapshot,at:number){
 const approval=rows.find(r=>r[0]==='approval');if(!approval)throw new ApiError(404,'not_found','No pending approval or proposed page.');
 const items:any[]=JSON.parse(approval[2][0]);
 if(approval[2][1]!=='pending'||!Array.isArray(items)||!items.length||items.length>50||new Set(items.map(i=>i.id)).size!==items.length||items.some(i=>i.status!=='pending'))throw new ApiError(409,'approval_changed','The approval changed. Request a current pending approval.');
 const proposed=new Map<string,any>(rows.filter(r=>r[0]==='live').map(([,id,v])=>[id,{id,kind:v[0],slug:v[1],version:v[2],data:JSON.parse(v[3]),published_at:v[4],created:v[5]??''}]));
 for(const item of items){
  const current=rows.find(r=>r[0]==='item'&&r[1]===item.id)?.[2],rev=rows.find(r=>r[0]==='revision'&&r[1]===item.id)?.[2];
  if(!current||current[2]!==item.version)throw new ApiError(409,'approval_changed','The approval changed. Request a current pending approval.');
  if(!rev||rev[0]!==item.version||current[3]!==rev[2])return unavailable();
  const data=JSON.parse(rev[1]);if(current[0]==='entry'&&data.status==='draft'&&!rev[2])throw new ApiError(409,'approval_changed','The approval changed. Request a current pending approval.');
  if(rev[2])proposed.delete(item.id);else proposed.set(item.id,{id:item.id,kind:current[0],slug:current[1],version:rev[0],data,published_at:new Date(at).toISOString(),created:current[4]});
 }
 const source=proposed.get('site');if(!source)throw new ApiError(404,'not_found','No pending approval or proposed page.');
 const data=logical(source.data,source.version,!items.some(i=>i.id==='site'),rows),v=site.view(data,[...proposed.values()].filter(r=>r.kind!=='site'));v.now=new Date(at);
 const visible=new Set(['site',...v.entries.map(e=>e.id),...v.cards.map(c=>c.id),...v.notes.map(n=>n.id)]),visibleRows=[...proposed.values()].filter(r=>visible.has(r.id));
 v.approved_at=Object.fromEntries(visibleRows.map(r=>[r.id,r.published_at]));
 v.share_cards=Object.fromEntries(rows.filter(r=>r[0]==='share'&&proposed.get(r[1])?.version===r[2][0]).map(([,id,c])=>[id,'/media/'+c[1]]));
 const hero=LOCAL.exec(String(data.hero));if(hero){let dimensions=rows.find(r=>r[0]==='media'&&r[1]===hero[1])?.[2];if(dimensions&&!dimensions[0]){const hex=rows.find(r=>r[0]==='header'&&r[1]===hero[1])?.[2][0];if(hex)dimensions=headerSize(Uint8Array.from(hex.match(/../g)??[],(b:string)=>parseInt(b,16)));}if(!dimensions||!dimensions[0])return unavailable();v.hero_size=[dimensions[0],dimensions[1]];}
 const last=visibleRows.reduce((a,r)=>r.published_at>a?r.published_at:a,'');if(last){const d=new Date(last),zone=String(data.timezone||'UTC');v.updated=`${dateString(d,{month:'short',day:'numeric'},zone)}, ${dateString(d,{hour:'numeric',minute:'2-digit'},zone)} ${(dateFormatter({timeZoneName:'short'},zone).formatToParts(d).find(p=>p.type==='timeZoneName')?.value??'UTC').replace(/^([ECMP])[SD]T$/,'$1T')}`;}
 const name=ALIASES[String(data.theme)]??String(data.theme),installed=rows.find(r=>r[0]==='theme'&&r[1]===name),t:Theme|null=installed?JSON.parse(installed[2][2]):THEMES[name]??null;if(!t&&name!=='built-in')return unavailable();
 return {v,t,items:items.map(i=>({id:i.id,version:i.version}))};
}
const ALLOW=new Set('main article section aside header footer nav div span p h1 h2 h3 h4 h5 h6 blockquote ul ol li dl dt dd strong em b i u s del ins code pre hr br table thead tbody tfoot tr th td caption figure figcaption details summary'.split(' '));
const DROP=new Set('head script style link base meta svg math template noscript form input button select option textarea object embed canvas'.split(' '));
export function inert(source:string):string{
 const tree=parseDocument(source);const find=(n:any):any=>n.tag==='body'?n:n.children.map(find).find(Boolean);const root=find(tree)??tree;
 const render=(n:any,depth=0):string=>{
  if(depth>128)return unavailable();if(!n.tag)return esc(n.text);
  if(DROP.has(n.tag)||Object.hasOwn(n.attrs,'hidden')||n.attrs['aria-hidden']==='true'||/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(n.attrs.style??'')||/(?:^|\s)sk-owner-link(?:\s|$)/.test(n.attrs.class??''))return '';
  if(n.tag==='img')return '<span>'+esc(n.attrs.alt?'Image: '+n.attrs.alt:'Image.')+'</span>';
  if(['iframe','video','audio','picture'].includes(n.tag))return '<span>Embedded content.</span>';
  const children=n.children.map((c:any)=>render(c,depth+1)).join('');if(!ALLOW.has(n.tag))return children;
  let attributes='';for(const name of ['rowspan','colspan','scope','start']){const value=n.attrs[name];if(value===undefined)continue;let normalized:string|undefined;
   if(name==='scope'&&n.tag==='th'&&['row','col','rowgroup','colgroup'].includes(value))normalized=value;
   if(((name==='rowspan'||name==='colspan')&&['td','th'].includes(n.tag)||name==='start'&&n.tag==='ol')&&/^-?\d+$/.test(value)){const v=Number(value);if(Number.isSafeInteger(v)&&(name==='start'?v>=-2147483648&&v<=2147483647:v>=1&&v<=1000))normalized=String(v);}
   if(normalized!==undefined)attributes+=' '+name+'="'+normalized+'"';
  }
  const tag=n.tag==='nav'?'div':n.tag;return '<'+tag+attributes+'>'+(['br','hr'].includes(tag)?'':children+'</'+tag+'>');
 };
 return '<!doctype html><html><head><meta charset="utf-8"><title>Preview</title></head><body><main><p>'+NOTICE+'</p>'+render(root)+'</main></body></html>';
}
function argumentsOf(args:Record<string,unknown>){
 if(!args||Object.keys(args).some(k=>!['approval_id','path','format'].includes(k))||typeof args.approval_id!=='string'||!/^[A-Za-z0-9_-]{8,40}$(?![\s\S])/.test(args.approval_id))return invalid();
 const path=args.path??'/',format=args.format??'markdown';if(typeof path!=='string'||/[\uD800-\uDFFF]/u.test(path)||bytes(path)>2048||!path.startsWith('/')||path.includes('//')||/[\\%?:#\x00-\x20\x7f]/.test(path)||path.split('/').some(p=>p==='.'||p==='..')||!path.endsWith('/')||!['markdown','html'].includes(String(format)))return invalid();
 if(/^\/(?:review|preview|setup|login|recover|invite|passkey|upload|mcp|api|media|static)(?:\/|$)/.test(path))return invalid();return {id:args.approval_id,path,format:String(format)};
}
export async function renderPage(v:site.SiteView,t:Theme|null,path:string,origin:string,release:string):Promise<string>{
 const policy={sources:v.site.embed_sources,origin};
 if(path==='/archive/'&&v.site.archive?.enabled)return (await site.allArchivePage(v,{sort:'date',tag:'',stream:''},origin,!!t).text());
 if(path==='/')return t?theme.render(t,'home',theme.homeView(v,release,origin),policy,false):site.home(v,origin).text();
 const entry=v.entries.find(e=>e.page===path&&!e.external_url);if(entry)return t?theme.render(t,'entry',theme.entryView(v,entry,release,origin),policy,false):site.entryPage(v,path,origin)!.text();
 if(t){const m=/^\/([a-z][a-z0-9-]{0,29})\/(?:tags\/([a-z0-9-]{1,30})\/)?$/.exec(path),av=m?theme.archiveView(v,m[1],release,origin,m[2]):null;if(av)return theme.render(t,m![2]?'tag':'archive',av,policy,false);}
 throw new ApiError(404,'not_found','No pending approval or proposed page.');
}
export async function read(db:D1Database,args:Record<string,unknown>,context:Context|undefined){
 if(!context)throw new ApiError(403,'unauthorized','This tool requires a live drafting connection.');
 let auth:Authority;try{auth=await context.authorize();}catch{throw new ApiError(403,'unauthorized','This tool requires a live drafting connection.');}
 const current=async()=>{let next:Authority;try{next=await context.authorize();}catch{throw new ApiError(403,'unauthorized','This tool requires a live drafting connection.');}if(next.principal!==auth.principal||next.epoch!==auth.epoch)throw new ApiError(403,'unauthorized','This tool requires a live drafting connection.');};
 const {id,path,format}=argumentsOf(args);let origin:string;try{const u=new URL(context.origin);if((u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return unavailable();origin=u.origin;if(context.siteOrigin&&origin!==new URL(context.siteOrigin).origin)return unavailable();}catch{return unavailable();}
 try{
  const at=Date.now(),rows=await capture(db,id),s=view(rows,at);const facts={rows,site:s.v.site,themed:!!s.t,entries:s.v.entries.map(e=>({id:e.id,page:e.page,streamId:e.stream,tags:e.tags??[],endpoint:e.event?.end||e.event?.start}))} as unknown as Facts,choice={base:path,kind:'html'} as Choice,clock=plan(facts,choice,at,false);if(clock.kind==='unknown')return unavailable();
  await current();const safe=inert(await renderPage(s.v,s.t,path,origin,context.release??'dev')),body=format==='html'?safe:markdownDocument(safe,origin+path,false).markdown;
  if(/[\uD800-\uDFFF]/u.test(body))return unavailable();
  const result={approval_id:id,path,content_type:format==='html'?'text/html; charset=utf-8':'text/markdown; charset=utf-8',notice:NOTICE,items:s.items,rendered_at:new Date(at).toISOString(),body};
  if(bytes(body)>MAX_BODY||bytes(JSON.stringify(result))>MAX_ENVELOPE)throw new ApiError(413,'preview_too_large','The proposed inspection copy is too large.');
  await current();let latest:Snapshot;try{latest=await capture(db,id);}catch{return changed();}if(JSON.stringify(latest)!==JSON.stringify(rows)||!valid(clock))return changed();await current();return result;
 }catch(error){await current();if(error instanceof ApiError)throw error;return unavailable();}
}
