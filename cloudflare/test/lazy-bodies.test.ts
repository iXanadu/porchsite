import {afterEach,expect,it,vi} from 'vitest';
import * as html from '../src/html';
import {homeView,archiveView,entryView,render} from '../src/theme';
import {sampleView} from '../src/themecheck';
import {THEMES} from '../src/themes.gen';
import {agentPage} from '../src/agent-pages';
import sample from '../../themes/personal-homepage/sample.json';
import fixture from '../../spec/fixtures/lazy-bodies.json';
afterEach(()=>vi.restoreAllMocks());
function state(count=20){const v=sampleView(THEMES['personal-homepage'],sample),original=v.entries[0];v.entries=Array.from({length:count},(_,i)=>({...original,id:'e'+i,slug:'e'+i,page:`/${original.stream}/e${i}/`,url:`/${original.stream}/e${i}/`,body:fixture.body,summary:fixture.summary}));v.site.sections=[original.stream];return v;}
const policy={sources:[fixture.source],origin:fixture.origin};
function theme(template:string,headings=false){return {manifest:{heading_ids:headings,body_h1_as_h2:headings},pages:{home:template,archive:template,entry:template},partials:{}} as any;}
it.each([false,true])('never parses unused bodies during metadata, heading policy or capability walks (%s)',headings=>{
 const spy=vi.spyOn(html,'markdown'),v=state(200),marker='<porchsite-embed data-key="authored" data-url="https%3A%2F%2Fexample.com%2Fplayer" data-title="Tour"></porchsite-embed>';
 const home=render(theme(marker+'{{#sections}}{{#all}}{{summary}}{{/all}}{{/sections}}',headings),'home',homeView(v,'1',fixture.origin),policy);
 const stream=render(theme('{{#entries}}{{summary}}{{/entries}}',headings),'archive',archiveView(v,(v.site.streams.find((s:any)=>s.id===v.entries[0].stream)!.path||v.entries[0].stream),'1',fixture.origin)!,policy);
 expect(home).toContain(fixture.summary);expect(stream).toContain(fixture.summary);expect(home).not.toContain('<iframe ');
 expect(spy.mock.calls.filter(c=>c[0]===fixture.body)).toHaveLength(0);
});
it('renders a consumed repeated body once with the selected heading policy and keeps embed limits',()=>{
 const spy=vi.spyOn(html,'markdown'),v=state(),view=homeView(v,'1',fixture.origin);
 const output=render(theme('{{#sections}}{{#all}}{{{body_html}}}{{/all}}{{/sections}}',true),'home',view,policy);
 expect(spy.mock.calls.filter(c=>c[0]===fixture.body)).toHaveLength(1);
 expect(output.match(/<iframe /g)).toHaveLength(12);expect(output.match(/<table(?: |>)/g)).toHaveLength(20);
 expect(output).toContain('<h2 id="repeated-heading">');expect(output).not.toContain('<h1');
 expect(output).not.toContain('<porchsite-embed');
});
it('does not share a memo across views or mutate a view when applying another heading policy',()=>{
 const spy=vi.spyOn(html,'markdown'),v=state(1),original=entryView(v,v.entries[0],'1',fixture.origin),t=theme('{{{entry.body_html}}}',true);
 expect(render(t,'entry',original,policy)).toContain('id="repeated-heading"');
 expect(render({...t,manifest:{}},'entry',original,policy)).toContain('<h1>Repeated heading</h1>');
 const next=entryView(v,v.entries[0],'1',fixture.origin);render({...t,manifest:{}},'entry',next,policy);
 expect(spy.mock.calls.filter(c=>c[0]===fixture.body)).toHaveLength(3);
});
it('renders anonymous negotiated Markdown once and preserves direct bytes and Vary',async()=>{
 const route=vi.fn(async(_req:Request)=>new Response('<html><head><title>Title</title></head><body><main><h1>Title</h1><p>Visible</p></main></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8',Vary:'Origin'}}));
 const missing=async()=>new Response('missing',{status:404}),map=async()=>new Response('map');
 const negotiated=await agentPage(new Request(fixture.origin+'/',{headers:{Accept:'text/markdown'}}),route,map,missing);
 expect(route).toHaveBeenCalledTimes(1);expect(route.mock.calls[0][0].headers.has('Accept')).toBe(false);
 const body=await negotiated.text();expect(negotiated.headers.get('Vary')).toBe('Origin, Accept');route.mockClear();
 const direct=await agentPage(new Request(fixture.origin+'/index.md'),route,map,missing);
 expect(route).toHaveBeenCalledTimes(1);expect(await direct.text()).toBe(body);
});
it('retains the credentialed projection path and passes misses through without a Markdown grant',async()=>{
 const route=vi.fn(async(_req:Request)=>new Response('<html><head><title>Title</title></head><body><main>Visible</main></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}}));
 const missing=async()=>new Response('missing',{status:404}),map=async()=>new Response('map');
 await agentPage(new Request(fixture.origin+'/',{headers:{Accept:'text/markdown',Cookie:'__Host-sk_owner=invalid'}}),route,map,missing);
 expect(route).toHaveBeenCalledTimes(2);
 const denied=vi.fn(async(_req:Request)=>new Response('missing',{status:404,headers:{'Content-Type':'text/html; charset=utf-8'}}));
 const res=await agentPage(new Request(fixture.origin+'/',{headers:{Accept:'text/markdown'}}),denied,map,missing);
 expect(res.status).toBe(404);expect(await res.text()).toBe('missing');expect(denied).toHaveBeenCalledTimes(1);
});
