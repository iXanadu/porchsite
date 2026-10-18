import {redirectFor} from './site';
/** Anonymous public validators from current dependency facts, never page bodies. */
import {validate} from './content';
import {isBuiltIn,ALIASES} from './themes';
import {frameCsp,PERMISSIONS} from './embeds';
import {markdownPath,pagePath,pageQuery,publicPath,representation,sessionRequest,matchesTag,PUBLIC_CACHE,trainingSignal} from './public-http';
// SQL equivalent of media.LOCAL; fixed engine literals, never caller SQL.
// D1 limits pattern length, so check the fixed shape and use a short hex test.
const LOCAL_HERO_SQL="substr(json_extract(data,'$.hero'),1,7)='/media/' AND length(substr(json_extract(data,'$.hero'),8,32))=32 AND substr(json_extract(data,'$.hero'),8,32) NOT GLOB '*[^0-9a-f]*' AND substr(json_extract(data,'$.hero'),40) IN ('.jpg','.png','.webp')";
export const FACTS_SQL=`WITH facts0(category,ident,value) AS ( SELECT 'live' AS category,l.item_id AS ident,json_array(l.kind,l.slug,l.version,l.published_at,i.created_at,json_extract(l.data,'$.status'),json_extract(l.data,'$.stream'),json_extract(l.data,'$.external_url'),CASE WHEN l.item_id='site' THEN l.data ELSE NULL END) AS value FROM live l LEFT JOIN items i ON i.id=l.item_id
 UNION ALL SELECT 'field',f.key,json_array(f.value,f.approved) FROM site_fields f JOIN live l ON l.version=f.version AND l.item_id='site'
 UNION ALL SELECT 'embed','site',json_array(f.sources,f.approved) FROM site_embed_sources f JOIN live l ON l.version=f.version AND l.item_id='site'),
facts1(category,ident,value) AS (SELECT 'streams','site',json_array(f.settings,f.approved) FROM site_stream_settings f JOIN live l ON l.version=f.version AND l.item_id='site'
 UNION ALL SELECT 'private','site',json_array(a.version) FROM private_approvals a JOIN live l ON l.version=a.version AND l.item_id='site'
 UNION ALL SELECT 'training','site',json_array(a.version) FROM training_approvals a JOIN live l ON l.version=a.version AND l.item_id='site'),
facts2(category,ident,value) AS (SELECT 'theme',name,json_array(version,sha256) FROM themes WHERE name=(SELECT CASE json_extract(data,'$.theme') WHEN 'classic' THEN 'personal-homepage' WHEN 'broadsheet' THEN 'product-page' ELSE COALESCE(json_extract(data,'$.theme'),'built-in') END FROM live WHERE item_id='site')
 UNION ALL SELECT 'share',c.item_id,json_array(c.version,c.name) FROM share_cards c JOIN live l ON l.item_id=c.item_id AND l.version=c.version
 UNION ALL SELECT 'media',name,json_array(width,height) FROM media WHERE name=(SELECT CASE WHEN ${LOCAL_HERO_SQL} THEN substr(json_extract(data,'$.hero'),8) ELSE NULL END FROM live WHERE item_id='site')
)
SELECT category,ident,value FROM (SELECT * FROM facts0 UNION ALL SELECT * FROM facts1 UNION ALL SELECT * FROM facts2) ORDER BY category,ident`;
type Row={category:string;ident:string;value:string};
export type Facts={rows:unknown[];site:Record<string,any>;entries:{id:string;slug:string;stream:string;streamId:string;page:string;external:string}[];hasSite:boolean;themed:boolean;disabled:boolean;private:boolean};
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
export function decode(rows:Row[]):Facts{
 const data=rows.map(r=>[r.category,r.ident,JSON.parse(r.value)] as [string,string,any[]]);
 // Embedded extension JSON is normalized rather than hashed as SQL serialization.
 for(const [kind,,value] of data)if(['field','embed','streams'].includes(kind))value[0]=value[1]?JSON.parse(value[0]):null;
 const at=(kind:string,id='site')=>data.find(r=>r[0]===kind&&r[1]===id)?.[2];
 const live=at('live'),raw=live?.[8]?JSON.parse(live[8]):{};
 if(live?.[8])live[8]=raw;
 const extension=at('streams');
 const field=(name:string)=>{const row=at('field',name);return row?.[1]?row[0]:undefined;};
 const sources=at('embed');
 const s=validate('site',{...raw,...(extension?.[1]?extension[0]:{}),embed_sources:sources?(sources[1]?sources[0]:[]):raw.embed_sources??[],private:!!at('private')&&field('private')===true,ai_training_disabled:!!at('training')&&field('ai_training_disabled')===true,broker:field('broker')??''});
 const streams=s.streams as Record<string,any>[];
 const entries=data.filter(r=>r[0]==='live'&&r[2][0]==='entry'&&r[2][5]!=='draft').map(([,id,v])=>{const st=streams.find(s=>s.id===v[6])??streams[0],stream=String(st.path||st.id);return {id,slug:String(v[1]),stream,streamId:String(st.id),page:`/${stream}/${v[1]}/`,external:String(v[7]??'')};});
 const theme=ALIASES[String(s.theme)]??String(s.theme);
 return {rows:ordered(data),site:s,entries,hasSite:!!live,themed:isBuiltIn(theme)||data.some(r=>r[0]==='theme'&&r[1]===theme),disabled:s.ai_training_disabled===true,private:s.private===true};
}
export async function facts(db:D1Database){return decode((await db.prepare(FACTS_SQL).all<Row>()).results);}
export type Choice={base:string;query:string;type:string;kind:'html'|'markdown'|'map'|'plain'|'xml'|'feed';direct:boolean};
export function choice(req:Request,f:Facts):Choice|null{
 if(sessionRequest(req)||!['GET','HEAD'].includes(req.method))return null;
 const u=new URL(req.url),md=markdownPath(u.pathname),base=md??u.pathname;
 if(!(publicPath(base)||base==='/llms.txt'))return null;
 const query=pageQuery(req,base);
 let kind:Choice['kind']='html',type='text/html; charset=utf-8';
 if(base==='/llms.txt'){kind='map';type='text/markdown; charset=utf-8';}
 else if(base==='/robots.txt'){kind='plain';type='text/plain; charset=utf-8';}
 else if(base==='/sitemap.xml'){kind='xml';type='application/xml; charset=utf-8';}
 else if(base.endsWith('/feed.xml')){kind='feed';type='application/atom+xml; charset=utf-8';}
 else if(pagePath(base)){const selected=md?'markdown':representation(req.headers.get('Accept'));if(!selected)return null;if(selected==='markdown'){kind='markdown';type='text/markdown; charset=utf-8';}}
 else return null;
 const st=f.site.streams as Record<string,any>[],paths=st.map(s=>String(s.path||s.id));
 let exists=['/','/robots.txt','/sitemap.xml','/llms.txt'].includes(base);
 if(base==='/archive/'&&f.site.archive.enabled)exists=true;
 if(f.entries.some(e=>!e.external&&base===`/${e.stream}/${e.slug}/`))exists=true;
 if(paths.some(p=>base===`/${p}/feed.xml`||f.themed&&(base===`/${p}/`||new RegExp('^/'+p+'/tags/[a-z0-9-]{1,30}/$').test(base))))exists=true;
 return exists?{base,query,type,kind,direct:!!md}:null;
}
export async function tag(f:Facts,req:Request,c:Choice,release:string,now=Date.now()){
 const input=JSON.stringify([f.rows,release,new URL(req.url).origin,c.base+c.query,c.type,trainingSignal(f.disabled),Math.floor(now/60000)]);
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input)));
 return `W/"dep1-${[...hash].map(n=>n.toString(16).padStart(2,'0')).join('')}"`;
}
export function headers(f:Facts,c:Choice,etag:string,origin:string){
 const h=new Headers({'Content-Type':c.type,'Cache-Control':PUBLIC_CACHE,'Content-Signal':trainingSignal(f.disabled),'ETag':etag});
 if(c.kind==='html'){
  let csp=f.themed&&c.base!=='/archive/'?"default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'":"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  if(c.base==='/archive/')csp=csp.replace("form-action 'none'","form-action 'self'");
  h.set('Content-Security-Policy',frameCsp(csp,f.site.embed_sources,origin));h.set('Permissions-Policy',PERMISSIONS);h.set('Referrer-Policy','strict-origin-when-cross-origin');h.set('X-Content-Type-Options','nosniff');
  h.set('Link',`<${c.base}index.md${c.query}>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"`);h.set('Vary','Accept');
 }else if(c.kind==='markdown'||c.kind==='map'){
  h.set('Content-Security-Policy',"default-src 'none'; base-uri 'none'; frame-ancestors 'none'");h.set('X-Content-Type-Options','nosniff');h.set('Link','</llms.txt>; rel="describedby"');if(!c.direct&&c.kind==='markdown')h.set('Vary','Accept');
 }
 return h;
}
export function conditional(req:Request,f:Facts,c:Choice,etag:string):Response|null{return matchesTag(req.headers.get('If-None-Match'),etag)?new Response(null,{status:304,headers:headers(f,c,etag,new URL(req.url).origin)}):null;}
export function unshaped(path:string){return !publicPath(path+'/')&&!/^\/[a-z][a-z0-9-]{0,29}\/search\.json$/.test(path)&&!publicPath(path)&&!markdownPath(path)&&!['/archive','/llms.txt'].includes(path)&&!/^\/(?:mcp|authorize|oauth|review|login|setup|recover|invite|passkey|upload|collect|media|static|alerts|app-icon|sw\.js|manifest\.webmanifest|\.well-known)(?:[/.]|$)/.test(path);}
export const missing=()=>new Response('<!doctype html><title>Not found</title>',{status:404,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'}});

/** Missing canonical pages need no full reader body; aliases keep old redirects. */
export async function miss(req:Request,f:Facts,db:D1Database):Promise<Response|null>{
 const u=new URL(req.url),md=markdownPath(u.pathname),path=md??u.pathname;
 if(!(publicPath(path)||publicPath(path+'/')||path==='/llms.txt'))return null;
 const probe=choice(new Request(req,{headers:{Accept:'text/html'}}),f);if(probe)return null;
 if(!md){
  if(path==='/archive'&&f.site.archive.enabled){pageQuery(req,'/archive/');return new Response(null,{status:301,headers:{Location:'/archive/'+u.search,'Cache-Control':'no-cache'}});}
  const external=f.entries.find(e=>e.page===path&&e.external);if(external)return new Response(null,{status:302,headers:{Location:external.external}});
  const to=redirectFor({site:f.site,entries:f.entries} as any,path);
  if(to)return new Response(null,{status:301,headers:{Location:to+u.search,'Cache-Control':'max-age=3600'}});
  const old=/^\/e\/([a-z0-9-]+)\/?$/.exec(path),legacy=old&&f.entries.find(e=>e.slug===old[1]);
  if(legacy)return new Response(null,{status:301,headers:{Location:legacy.external||legacy.page}});
  const part=/^\/([a-z][a-z0-9-]{0,29})\/([a-z0-9-]{1,80})\/?$/.exec(path);
  if(part){const id=await db.prepare('SELECT item_id FROM slug_history WHERE slug = ? ORDER BY created_at DESC, version DESC LIMIT 1').bind(part[2]).first<string>('item_id');const e=f.entries.find(e=>e.id===id);if(e&&e.page!==path&&[e.stream,e.streamId,'e'].includes(part[1]))return new Response(null,{status:301,headers:{Location:e.page+u.search,'Cache-Control':'max-age=3600'}});}
 }
 return missing();
}

export function candidate(path:string){return !/^\/(?:review|login|setup|recover|invite|passkey|upload|authorize|oauth|mcp|static|alerts|collect|health|\.well-known)(?:\/|$)/.test(path)&&(publicPath(path)||publicPath(path+'/')||markdownPath(path)||path==='/llms.txt');}
