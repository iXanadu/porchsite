/** Restricted projections never load staged items or approval metadata. */
import {liveView} from './site';
import {streams} from './theme';
import {checkSite,checkSiteDeep} from './check';
import * as themes from './themes';
import {ApiError} from './errors';
import {INSTRUCTIONS} from './read-keys';
const digest=async(value:unknown)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
export async function state(db:D1Database,args:any,principal:Record<string,unknown>={}){
 if(args.full===true||args.ids!==undefined)throw new ApiError(403,'unauthorized','Only the published page listing is available.');
 const v=await liveView(db,true);
 const visible=['site',...v.entries.map(e=>e.id),...v.cards.map(e=>e.id),...v.notes.map(e=>e.id)];
 let changed=visible.map(id=>v.approved_at?.[id]??'').sort().at(-1)??'';
 const installed=await db.prepare('SELECT installed_at FROM themes WHERE name=?').bind(String(v.site.theme)).first<string>('installed_at');if(installed&&installed>changed)changed=installed;
 const paths=v.approved_at?.site?[{path:'/',title:String(v.site.title),changed_at:changed}]:[];
 if(v.approved_at?.site&&v.site.archive?.enabled)paths.push({path:'/archive/',title:String(v.site.archive.title),changed_at:changed});
 for(const s of v.approved_at?.site?streams(v.site):[])paths.push({path:s.archive_url,title:s.title,changed_at:changed});
 for(const e of v.entries)if(!e.external_url)paths.push({path:e.page,title:String(e.title),changed_at:[v.approved_at?.site??'',v.approved_at?.[e.id]??'',installed??''].sort().at(-1)??''});
 paths.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const generation=await digest(paths),binding=await digest([principal.readKeyId,principal.ownerEpoch]);
 const next_cursor=paths.length>20?'ag1_'+btoa(JSON.stringify({v:1,after:paths[19].path,generation,binding})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''):null;
 const read_guide={scope:'published_read',tools:['site_state','site_check','page_get','pages_list','search'],description:INSTRUCTIONS};
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(read_guide))),revision='published-read-'+[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
 const included=args.guide?.known_revision!==revision;
 return {scope:'published_read',site:{title:String(v.site.title)},pages:paths.slice(0,20),next_cursor,...(included?{read_guide}:{}),...(args.guide!==undefined?{guide:{revision,included}}:{})};
}
export async function check(db:D1Database,args:any,origin:string){
 const v=await liveView(db),text=JSON.stringify(v),all=(await db.prepare('SELECT name FROM media').all<{name:string}>()).results;
 const names=new Set(all.filter(r=>text.includes('/media/'+r.name)).map(r=>r.name));
 return args.deep?checkSiteDeep(v,names,await themes.load(db,String(v.site.theme)),origin):checkSite(v,names);
}
