/** Renderer clock registry: add a producer here before it may reach public output. */
import {hoursView,noticeView} from './blocks';
import {rules,wall,occurrences} from './public-time-clock';
import type {Facts,Choice} from './public-read';
export type Plan={kind:'static'|'bounded'|'unknown';state:unknown;next_change:number|null;at:number};
export const REGISTRY=['hours','notice','event'] as const;
const cache=new Map<string,Plan>();
const stable=(v:any):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const shift=(date:string,days:number)=>new Date(Date.parse(date+'T12:00Z')+days*86400000).toISOString().slice(0,10);
export function plan(f:Facts,c:Choice,now=Date.now(),cacheable=true):Plan{
 const empty:Plan={kind:'static',state:[],next_change:null,at:now};
 // These builders do not call themed blocks, even when another page does.
 if(!f.themed||c.base==='/archive/'||!['html','markdown'].includes(c.kind))return empty;
 const s=f.site,zone=String(s.timezone||'UTC'),hours=s.hours?.weekly?.length?s.hours:null,notice=s.notice?.text&&s.notice?.until?s.notice:null;
 const selected=f.entries.find(e=>e.page===c.base),stream=(s.streams as any[]).find(x=>c.base===`/${x.path||x.id}/`||c.base.startsWith(`/${x.path||x.id}/tags/`));
 const tag=/\/tags\/([^/]+)\/$/.exec(c.base)?.[1];
 const sections=new Set((s.sections as string[]).flatMap(k=>k==='entries'?(s.streams as any[]).filter(x=>!s.sections.includes(x.id)).map(x=>x.id):[k]));
 const events=f.entries.filter(e=>e.endpoint&&(selected?e.id===selected.id:stream?e.streamId===stream.id&&(!tag||e.tags.includes(tag)):c.base==='/'&&sections.has(e.streamId))).map(e=>[e.id,e.endpoint]);
 if(!hours&&!notice&&!events.length)return empty;
 const unknown:Plan={kind:'unknown',state:null,next_change:null,at:now},r=rules(zone,now),local=wall(now,zone);if(!r||!local)return unknown;
 const key=stable([s.theme,f.rows.filter((r:any)=>r[0]==='theme'),zone,hours,notice,events,c.base,c.kind]),cached=cacheable?cache.get(key):undefined;
 if(cached&&now>=cached.at&&cached.next_change!==null&&now<cached.next_change)return {...cached,at:now};
 try{
  const stateAt=(at:number)=>{const n=wall(at,zone);if(!n)throw Error('unsupported clock');return [hours?hoursView(hours,zone,new Date(at)):null,notice?noticeView(notice,zone,new Date(at)):null,events.map(([id,end])=>[id,String(end)<n.date+'T'+n.time])];};
  const state=stateAt(now),encoded=stable(state),candidates=new Set<number>([r[0]*1000]);
  const add=(stamp:string)=>{for(const at of occurrences(stamp,zone,now))if(at>now)candidates.add(at);};
  if(hours){
   for(const days of [0,1,2]){const d=shift(local.date,days);if(days)add(d+'T00:00');for(const row of [...hours.weekly,...(hours.exceptions??[])])for(const name of ['open','close'])if(row[name])add(d+'T'+row[name]);}
  }
  if(notice)add(shift(notice.until,1)+'T00:00');
  for(const [,end] of events)add(new Date(Date.parse(end+'Z')+60000).toISOString().slice(0,16));
  // Exact transition instants catch gaps, both fold occurrences and skipped dates.
  for(const [at] of r[2])if(at*1000>now)candidates.add(at*1000);
  let next=r[0]*1000;
  for(const at of [...candidates].sort((a,b)=>a-b)){
   if(at>=next)break;
   if(stable(stateAt(at))!==encoded){next=at;break;}
  }
  const result:Plan={kind:'bounded',state,next_change:next,at:now};
  if(cacheable){if(cache.size>=32)cache.delete(cache.keys().next().value!);cache.set(key,result);}return result;
 }catch{return unknown;}
}
export const valid=(p:Plan,now=Date.now())=>p.kind!=='unknown'&&now>=p.at&&(p.next_change===null||now<p.next_change);
