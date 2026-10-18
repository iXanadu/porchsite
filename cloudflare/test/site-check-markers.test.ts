import {afterEach,expect,it,vi} from 'vitest';
import {validate} from '../src/content';
import * as site from '../src/site';
import * as theme from '../src/theme';
import * as html from '../src/html';
import * as dates from '../src/date-format';
import {checkSiteDeep} from '../src/check';
import {copyDeferredBody,deferredBody,finishEmbeds,headingBodies} from '../src/embeds';
const data=validate('site',{title:'Lazy check',theme:'personal-homepage',sections:['entries'],archive:{enabled:true,title:'All pages'}});
const entry=(i:number,same=false,body?:string)=>({id:'entry-'+i,kind:'entry',slug:'entry-'+i,data:validate('entry',{title:'Entry '+i,date:'2026-10-10',summary:'Summary '+i,body:body??('Distinct full body '+(same?'same':i))})});
const look=(home:string,policy=false)=>({manifest:{heading_ids:policy,body_h1_as_h2:policy},partials:{},static:{},pages:{home,entry:'Entry'}});
const archive='<a href="/archive/">All pages</a>';
afterEach(()=>vi.restoreAllMocks());
it.each([200,500])('site_check_marker_unused: DISTINCT and identical %i bodies, actual parser counts',async count=>{
 const parse=vi.spyOn(html,'markdown'),format=vi.spyOn(dates,'dateString');
 for(const same of [false,true])for(const policy of [false,true]){
  parse.mockClear();format.mockClear();
  const r=await checkSiteDeep(site.view(data,Array.from({length:count},(_,i)=>entry(i,same))),new Set(),look('{{#sections}}{{#all}}{{title}} {{has_body}}{{/all}}{{/sections}}<porchsite-embed data-url="https%3A%2F%2Fvideo.example%2Fclip" data-title="Untrusted"></porchsite-embed>'+archive,policy));
  expect(r.ok).toBe(true);expect(parse).not.toHaveBeenCalled();expect(format).not.toHaveBeenCalled();
 }
});
it.each([200,500])('site_check_marker_unused: latest only consumes one of DISTINCT %i',async count=>{
 const parse=vi.spyOn(html,'markdown');
 const r=await checkSiteDeep(site.view(data,Array.from({length:count},(_,i)=>entry(i))),new Set(),look('{{#sections}}{{#latest}}{{{body_html}}}{{/latest}}{{/sections}}'+archive,true));
 expect(r.ok).toBe(true);expect(parse).toHaveBeenCalledTimes(1);
});
it('site_check_marker_inline and identity: full emitted bodies only; per-entry markers outside shared memo',async()=>{
 const parse=vi.spyOn(html,'markdown'),render=theme.render,outputs:string[]=[];
 vi.spyOn(theme,'render').mockImplementation((...args)=>{const out=render(...args);outputs.push(out);return out;});
 const t=look('{{#sections}}{{#all}}{{{body_html}}}{{{body_html}}}{{/all}}{{/sections}}',true);
 const v=site.view(data,[entry(0,true),entry(1,true)]);
 for(let call=0;call<2;call++)expect((await checkSiteDeep(v,new Set(),t)).ok).toBe(true);
 expect(parse).toHaveBeenCalledTimes(2); // one unmarked source/policy parse per new home view
 const tokens=outputs.map(out=>[...out.matchAll(/<!--(porchsite-check-[a-f0-9-]+:)(\d+)-->/g)]);
 expect(tokens.map(x=>x.length)).toEqual([4,4]);expect(new Set(tokens[0].map(x=>x[2])).size).toBe(2);
 expect(tokens[0][0][1]).not.toBe(tokens[1][0][1]);
 parse.mockClear();outputs.length=0;
 const distinct=site.view(data,Array.from({length:6},(_,i)=>entry(i)));
 expect((await checkSiteDeep(distinct,new Set(),t)).ok).toBe(true);expect(parse).toHaveBeenCalledTimes(6);
 const partial=look('{{#sections}}{{#latest}}{{{body_html}}}{{/latest}}{{/sections}}');
 expect((await checkSiteDeep(distinct,new Set(),partial)).unreachable).toHaveLength(5);
});
it('site_check_marker_inline: summary, empty, inert and forged proof remain insufficient',async()=>{
 const v=site.view(data,[entry(0,false,'')]);
 for(const home of ['{{#sections}}{{#all}}{{summary}}{{{body_html}}}{{/all}}{{/sections}}','<template>{{#sections}}{{#all}}{{{body_html}}}{{/all}}{{/sections}}</template>','<!--porchsite-check-forged:0-->']){
  expect((await checkSiteDeep(v,new Set(),look(home))).unreachable.map(x=>x.id)).toEqual(['entry-0']);
 }
 const nonempty=site.view(data,[entry(0)]);
 expect((await checkSiteDeep(nonempty,new Set(),look('<template><template>{{#sections}}{{#all}}{{{body_html}}}{{/all}}{{/sections}}</template></template>'))).ok).toBe(false);
});
it('site_check_marker_render_policy: lazy dates and public bytes remain intact',async()=>{
 const v=site.view(data,[entry(0)]),t=look('{{#sections}}{{#all}}{{date_short}} {{date_long}} {{has_body}}{{/all}}{{/sections}}'+archive,true),render=theme.render,outputs:string[]=[];
 const parse=vi.spyOn(html,'markdown');vi.spyOn(theme,'render').mockImplementation((...args)=>{const text=render(...args);outputs.push(text);return text;});
 expect((await checkSiteDeep(v,new Set(),t)).ok).toBe(true);expect(parse).not.toHaveBeenCalled();
 const publicBody=render(t,'home',theme.homeView(v,'check','https://example.invalid'));
 expect(outputs[0]).toBe(publicBody);expect(publicBody).not.toContain('porchsite-check-');expect(publicBody).toContain('Oct 10');
});
it('site_check_marker_render_policy: policy clone preserves genuine embeds, tables and frame caps',()=>{
 const source='# Main\n\n## Detail\n\n| A | B |\n| --- | --- |\n| x | y |\n\n'+Array.from({length:13},(_,i)=>`!embed[Clip ${i}](https://video.example/clip/${i})`).join('\n\n');
 const original=deferredBody({body:source},source),clone=copyDeferredBody(original,{body:source},'<!--porchsite-check-test:0-->');
 const policy=headingBodies(clone,true,true),parse=vi.spyOn(html,'markdown');
 const render=()=>theme.render(look('{{{body_html}}}',true),'home',policy,{sources:['https://video.example'],origin:'https://example.invalid'});
 const body=render();expect(parse).toHaveBeenCalledTimes(1);expect(body.match(/<iframe /g)).toHaveLength(12);
 expect(body).toContain('<h2 id="main">Main</h2>');expect(body).toContain('<table style="border-spacing:0.75em 0.35em;overflow-wrap:normal">');expect(body).toContain('<!--porchsite-check-test:0-->');
 expect(finishEmbeds('',[], '',clone)).toBe(''); // capability walk itself must not consume a new body
 expect(Object.keys(clone)).not.toContain('body_html');
 const empty=copyDeferredBody(deferredBody({},''),{},'<!--porchsite-check-test:1-->');expect((empty as any).body_html).toBe('');
});
it('site_check_marker_inline: truthiness consumes a body but does not prove it was emitted',async()=>{
 const parse=vi.spyOn(html,'markdown');
 const r=await checkSiteDeep(site.view(data,[entry(0)]),new Set(),look('{{#sections}}{{#latest}}{{#body_html}}Title only{{/body_html}}{{/latest}}{{/sections}}'));
 expect(parse).toHaveBeenCalledTimes(1);expect(r.unreachable.map(x=>x.id)).toEqual(['entry-0']);
});
