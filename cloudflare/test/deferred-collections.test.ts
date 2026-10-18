import {afterEach,expect,it,vi} from 'vitest';
import {deferFields,mapFields,visitedValues} from '../src/deferred-fields';
import {deferredBody,headingBodies} from '../src/embeds';
import * as theme from '../src/theme';
import * as site from '../src/site';
import * as html from '../src/html';
import {validate} from '../src/content';
import {checkSiteDeep} from '../src/check';
const origin='https://site.example',source='https://video.example';
const look=(home:string,headings=false)=>({manifest:{heading_ids:headings,body_h1_as_h2:headings},partials:{},static:{},pages:{home,entry:'Entry'}} as any);
function state(count=5){
 const v=site.view(validate('site',{title:'Collection fixture',theme:'personal-homepage',sections:['entries'],archive:{enabled:true}}),Array.from({length:count},(_,i)=>({id:'entry-'+i,kind:'entry',slug:'entry-'+i,data:validate('entry',{title:'Entry '+i,date:'2026-10-10',summary:'Summary',body:'# Heading\n\nDistinct body '+i})})));
 v.cards=[{id:'card-0',name:'Card',description:'Description',group:'',tags:[]}];return v;
}
afterEach(()=>vi.restoreAllMocks());
it('deferred collection registry: enumerable fields, memoized real consumption and explicit clone semantics',()=>{
 const read=vi.fn(()=>[1,2]),view=deferFields({plain:3},{all:read}),mapped=mapFields(view,v=>Array.isArray(v)?v.map(x=>x+1):v);
 expect(Object.keys(view)).toContain('all');expect(Object.keys(mapped)).toContain('all');
 expect(visitedValues(view)).toEqual([3]);expect(visitedValues(mapped)).toEqual([3]);expect(read).not.toHaveBeenCalled();
 expect(mapped.all).toEqual([2,3]);expect(mapped.all).toBe(mapped.all);expect(read).toHaveBeenCalledTimes(1);
 expect(visitedValues(mapped)).toContain(mapped.all);
});
it.each([200,500])('home context leaves all/highlights unprojected on %i entries until a custom look consumes them',count=>{
 const v=state(count),last=vi.fn(()=>[]),card=vi.fn(()=>'Description');
 Object.defineProperty(v.entries[count-1],'stats',{enumerable:true,get:last});
 Object.defineProperty(v.cards[0],'description',{enumerable:true,get:card});
 const context=theme.homeView(v,'test',origin),parse=vi.spyOn(html,'markdown');
 for(const policy of [false,true]){
  const out=theme.render(look('{{#sections}}{{#items}}{{title}}{{/items}}{{/sections}}<porchsite-embed data-url="https%3A%2F%2Fvideo.example%2Fclip" data-title="Authored"></porchsite-embed>',policy),'home',context,{sources:[source],origin});
  expect(out).not.toContain('<iframe');expect(last).not.toHaveBeenCalled();expect(card).not.toHaveBeenCalled();expect(parse).not.toHaveBeenCalled();
 }
 const custom=look('{{#sections}}{{#all}}{{title}};{{/all}}{{/sections}}{{#highlights}}{{description}}{{/highlights}}');
 const body=theme.render(custom,'home',context);expect(body).toContain('Entry '+(count-1));expect(body).toContain('Description');
 expect(last).toHaveBeenCalled();expect(card).toHaveBeenCalledTimes(1);
 const previous=last.mock.calls.length;expect(theme.render(custom,'home',context)).toBe(body);expect(last).toHaveBeenCalledTimes(previous);expect(card).toHaveBeenCalledTimes(1);expect(parse).not.toHaveBeenCalled();
});
it('heading consumer preserves policy through an unread collection and does not mutate the original recipe',()=>{
 const read=vi.fn(()=>[deferredBody({body:'# Main\n\n## Detail'},'# Main\n\n## Detail')]),unused=vi.fn(()=>[]),view=deferFields({},{all:read,highlights:unused});
 const clone=headingBodies(view,true,true);expect(read).not.toHaveBeenCalled();expect(unused).not.toHaveBeenCalled();
 const body=theme.render(look('{{#all}}{{{body_html}}}{{/all}}'),'home',clone);
 expect(body).toContain('<h2 id="main">Main</h2>');expect(body).toContain('<h2 id="detail">Detail</h2>');expect(unused).not.toHaveBeenCalled();
 expect(theme.render(look('{{#all}}{{{body_html}}}{{/all}}'),'home',view)).toContain('<h1>Main</h1>');expect(read).toHaveBeenCalledTimes(1);
});
it('embed consumer discovers only resolved collection capabilities and preserves frame limits',()=>{
 const body=Array.from({length:13},(_,i)=>`!embed[Clip ${i}](${source}/clip/${i})`).join('\n\n');
 const read=vi.fn(()=>[deferredBody({body},body)]),unused=vi.fn(()=>[]),view=deferFields({},{all:read,highlights:unused});
 const out=theme.render(look('{{#all}}{{{body_html}}}{{/all}}',true),'home',view,{sources:[source],origin});
 expect(out.match(/<iframe /g)).toHaveLength(12);expect(out).not.toContain('<porchsite-embed');expect(read).toHaveBeenCalledTimes(1);expect(unused).not.toHaveBeenCalled();
});
it('deep-check consumer marks bodies created by deferred all with invocation-local proof',async()=>{
 const v=state(4),parse=vi.spyOn(html,'markdown'),render=theme.render,output:string[]=[];
 vi.spyOn(theme,'render').mockImplementation((...args)=>{const text=render(...args);output.push(text);return text;});
 const custom=look('{{#sections}}{{#all}}{{{body_html}}}{{/all}}{{/sections}}',true);
 for(let i=0;i<2;i++)expect((await checkSiteDeep(v,new Set(),custom,origin)).ok).toBe(true);
 expect(parse).toHaveBeenCalledTimes(8);
 const markers=output.map(text=>[...text.matchAll(/<!--(porchsite-check-[a-f0-9-]+:)(\d+)-->/g)]);
 expect(markers.map(x=>x.length)).toEqual([4,4]);expect(new Set(markers[0].map(x=>x[2])).size).toBe(4);expect(markers[0][0][1]).not.toBe(markers[1][0][1]);
 const publicBody=render(custom,'home',theme.homeView(v,'test',origin));expect(publicBody).not.toContain('porchsite-check-');
 expect((await checkSiteDeep(v,new Set(),look('<template>{{#sections}}{{#all}}{{{body_html}}}{{/all}}{{/sections}}</template>',true),origin)).unreachable).toHaveLength(4);
});
