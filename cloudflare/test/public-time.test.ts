import {it,expect,vi} from 'vitest';
import fixture from '../../spec/fixtures/public-time.json';
import {validate} from '../src/content';
import {plan,valid} from '../src/public-time';
import {localNow,hoursView,noticeView,eventView} from '../src/blocks';
import type {Facts,Choice} from '../src/public-read';
import {tag} from '../src/public-read';
const c:Choice={base:'/',query:'',type:'text/html; charset=utf-8',kind:'html',direct:false};
function facts(x:any={}):Facts {return {site:validate('site',{theme:'local-business',timezone:x.zone??'UTC',...(x.hours?{hours:x.hours}:{}),...(x.notice?{notice:x.notice}:{})}),entries:x.endpoint?[{id:'event',slug:'event',stream:'journal',streamId:'journal',page:'/journal/event/',external:'',endpoint:x.endpoint,tags:[]}]:[],rows:[],hasSite:true,themed:true,disabled:false,private:false};}
function output(f:Facts,at:number){const s=f.site,d=new Date(at);return JSON.stringify([hoursView(s.hours,s.timezone,d),noticeView(s.notice,s.timezone,d),f.entries.map(e=>eventView({start:e.endpoint},s.timezone,d).is_past)]);}
it.each(fixture.cases)('af_time_$name',x=>{
 const f=facts(x),before=Date.parse(x.before),boundary=Date.parse(x.boundary),p=plan(f,c,before);
 expect(p.kind).toBe('bounded');expect(p.next_change).toBe(boundary);expect(valid(p,boundary-1)).toBe(true);expect(valid(p,boundary)).toBe(false);
 expect(output(f,boundary-1)).toBe(output(f,before));expect(output(f,boundary)).not.toBe(output(f,before));expect(plan(f,c,boundary).state).not.toEqual(p.state);
 if(x.name==='hours_exception_horizon'){expect((p.state as any[])[0].exceptions).toHaveLength(0);expect((plan(f,c,boundary).state as any[])[0].exceptions).toHaveLength(1);}
 if(x.name==='hours_next_open_lookahead'){expect((p.state as any[])[0].status).toBe('Closed now');expect((plan(f,c,boundary).state as any[])[0].status).toContain('opens');}
 // Independent UTC grid does not take its sample instants from the planner.
 for(let t=before;t<boundary;t+=37000)expect(output(f,t)).toBe(output(f,before));
});
it('af_time_static_sparse: hour+ unchanged; map excludes unrelated clock chrome',async()=>{
 const f=facts(),req=new Request('https://site.example/'),now=Date.parse('2026-10-19T08:00Z');
 expect(plan(f,c,now).kind).toBe('static');expect(await tag(f,req,c,'test',now)).toBe(await tag(f,req,c,'test',now+7200000));
 const timed=facts(fixture.cases[0]);for(const kind of ['map','feed','plain','xml'] as const)expect(plan(timed,{...c,kind},now).kind).toBe('static');
 expect(plan(timed,{...c,base:'/archive/'},now).kind).toBe('static');expect(plan({...timed,themed:false},c,now).kind).toBe('static');
});
it('af_time_unknown_and_rollback: unsupported zone/range never earns a validator; cached interval cannot survive rollback',async()=>{
 const f=facts(fixture.cases[0]),now=Date.parse('2026-10-19T08:00Z');f.site.timezone='No/Such_Zone';expect(plan(f,c,now).kind).toBe('unknown');expect(await tag(f,new Request('https://site.example/'),c,'test',now)).toBeNull();
 f.site.timezone='UTC';expect(plan(f,c,Date.parse('2200-01-01Z')).kind).toBe('unknown');const p=plan(f,c,now);expect(valid(p,now-1)).toBe(false);const reused=plan(f,c,now+1000);expect(reused.at).toBe(now+1000);expect(valid(reused,now+999)).toBe(false);expect(plan(f,c,now-1).at).toBe(now-1);
});
it('af_time_projection_scope: entry excludes another event; themed stream keeps shared notice',()=>{
 const f=facts({endpoint:'2026-10-19T10:00'}),now=Date.parse('2026-10-19T09:00Z');expect(plan(f,{...c,base:'/journal/other/'},now).kind).toBe('static');
 f.site.notice={text:'Date bound',until:'2026-10-19'};expect(plan(f,{...c,base:'/journal/'},now).kind).toBe('bounded');expect(localNow(new Date(now),'UTC').time).toBe('09:00');
});
it('af_time_complete_registry: every bundled renderer agrees with state at independent UTC grid points',async()=>{
 const {THEMES}=await import('../src/themes.gen'),{view}=await import('../src/site'),theme=await import('../src/theme');
 for(const x of fixture.cases){
  const f=facts(x),start=Date.parse(x.before)-7200000;
  const item=validate('entry',{title:'Time-bound entry',date:'2026-10-18',...(x.endpoint?{event:{start:x.endpoint}}:{})});
  for(const [name,t] of Object.entries(THEMES)){
   const v=view({...f.site,theme:name},[{id:'event',kind:'entry',slug:'event',data:item}]);
   let previous:{body:string;state:string}|undefined;
   for(let at=start;at<=Date.parse(x.boundary)+7200000;at+=17*60000){
    v.now=new Date(at);const state=JSON.stringify(plan(f,c,at).state),body=theme.render(t,'home',theme.homeView(v,'test','https://site.example'));
    if(previous&&state===previous.state)expect(body,`${x.name}/${name}/${new Date(at).toISOString()}`).toBe(previous.body);
    previous={body,state};
   }
  }
 }
});
it('af_time_lazy_artifact: quiet render and validator do not parse the zone payload',async()=>{
 const {default:payload}=await import('../../server/server/spec/public-time-zones.json');expect(typeof payload).toBe('string');
 const f=facts(),now=Date.parse('2026-10-19T08:00Z'),parsing=vi.spyOn(JSON,'parse');
 try{expect(plan(f,c,now).kind).toBe('static');hoursView(undefined,'UTC',new Date(now));noticeView(undefined,'UTC',new Date(now));eventView(null,'UTC',new Date(now));expect(parsing).not.toHaveBeenCalled();}finally{parsing.mockRestore();}
});
