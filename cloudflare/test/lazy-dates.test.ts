import {afterEach,expect,it,vi} from 'vitest';
import {homeView,archiveView,render} from '../src/theme';
import {sampleView} from '../src/themecheck';
import {THEMES} from '../src/themes.gen';
import sample from '../../themes/personal-homepage/sample.json';
afterEach(()=>vi.restoreAllMocks());
function state(){const v=sampleView(THEMES['personal-homepage'],sample),e=v.entries[0];v.entries=Array.from({length:200},(_,i)=>({...e,id:'e'+i,date:'2026-10-17'}));v.site.sections=[e.stream];return v;}
const theme=(template:string,headings:boolean)=>({manifest:{heading_ids:headings,body_h1_as_h2:headings},pages:{home:template,archive:template},partials:{}} as any);
it.each([false,true])('perf5_lazy_dates: metadata/heading/capability walks do not format dates (%s)',headings=>{
 const original=Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype,'format')!.get!;let dates=0;
 vi.spyOn(Intl.DateTimeFormat.prototype as {format:unknown},'format','get').mockImplementation(function(this:Intl.DateTimeFormat){const format=original.call(this);return(date?:number|Date)=>{if(Number(date)===Date.parse('2026-10-17T12:00Z'))dates++;return format(date);};});
 const v=state(),home=homeView(v,'1','https://site.example'),stream=v.site.streams.find((s:any)=>s.id===v.entries[0].stream)!;
 render(theme('<porchsite-embed data-url="https%3A%2F%2Fexample.com%2Fp" data-title="x"></porchsite-embed>{{#sections}}{{#all}}{{summary}}{{/all}}{{/sections}}',headings),'home',home);
 const archive=archiveView(v,stream.path||stream.id,'1','https://site.example')!;render(theme('{{#entries}}{{summary}}{{/entries}}',headings),'archive',archive);expect(dates).toBe(0);
 const t=theme('{{#sections}}{{#all}}{{date_short}} {{date_long}} {{date_short}}{{/all}}{{/sections}}',headings);
 const body=render(t,'home',home);expect(body).toContain('Oct 17 October 17, 2026 Oct 17');expect(dates).toBe(2);
 render({...t,manifest:{}},'home',home);expect(dates).toBe(2);
 render(t,'home',homeView(v,'1','https://site.example'));expect(dates).toBe(4);
});
