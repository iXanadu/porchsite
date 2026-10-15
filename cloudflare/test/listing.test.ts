import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {markdown} from '../src/html';
import {bodyMarkdown} from '../src/embeds';
import {render,homeView,entryView} from '../src/theme';
import {THEMES} from '../src/themes.gen';
import {sampleView,renderSample,rules} from '../src/themecheck';
import * as themes from '../src/themes';
import * as check from '../src/check';
import {MODELS} from '../src/models';
import type {Env} from '../src/env';
import type {Theme} from '../src/themes';
import sample from '../../themes/listing-page/sample.json';
import headingCases from '../../spec/heading-id-cases.json';
const db=(env as unknown as Env).DB,t=THEMES['listing-page'] as Theme;
it('makes stable visible-text heading ids only when opted in',()=>{
 const source='## Video **tour**\n\n## [Video tour](https://example.com/private)\n\n### Café & garden\n\n## 你好\n\n## !!!\n\n## Video tour-2\n\n> ## A room\n\n- ## A room\n\n```\n## No anchor\n```';
 const ordinary=markdown(source).html,html=markdown(source,undefined,true).html;
 expect(ordinary).not.toMatch(/<h[1-6] id=/);
 for(const id of ['video-tour','video-tour-2','caf-garden','section','section-2','video-tour-2-2','a-room','a-room-2'])expect(html).toContain('id="'+id+'"');
 expect(html).not.toContain('id="no-anchor"');
 const view={entry:{body:source,body_html:bodyMarkdown(source)}};
 const mini:any={manifest:{},pages:{entry:'{{{entry.body_html}}}'},partials:{}};
 expect(render(mini,'entry',view)).toBe(ordinary);
 expect(render({...mini,manifest:{heading_ids:false}},'entry',view)).toBe(ordinary);
 expect(render({...mini,manifest:{heading_ids:true}},'entry',view)).toBe(html);
 expect(String(view.entry.body_html)).toBe(ordinary);
});
it('retains genuine embed authority while adding headings and keeps previews as links',()=>{
 const source='## Video tour\n\n!embed[Tour](https://example.com/player)',view={entry:{body:source,body_html:bodyMarkdown(source)}};
 const mini:any={manifest:{heading_ids:true},pages:{entry:'{{{entry.body_html}}}'},partials:{}};
 expect(render(mini,'entry',view,{sources:['https://example.com'],origin:'https://site.example'})).toContain('<iframe ');
 expect(render(mini,'entry',view)).not.toContain('<iframe ');
 expect(render(mini,'entry',view)).toContain('<h2 id="video-tour">');
});
it('renders all listing pages, on-site anchor actions, gallery, price, visit and truthful photo guidance',async()=>{
 expect(rules('listing-page',t,{scripts:true})).toEqual([]);
 expect(rules('listing-page',{...t,manifest:{...t.manifest,heading_ids:'true'}},{scripts:true})).toContain('heading_ids must be a boolean');
 const pages=renderSample(t,sample);expect(Object.keys(pages)).toHaveLength(5);
 const home=pages['index.html'],entry=pages['listing/home/index.html'];
 for(const page of [home,entry])for(const text of ['id="photos"','id="video-tour"','id="walk-through"','id="open-house"','class="stats"','class="listing-body"','owner@example.com','https://maps.example/property'])expect(page).toContain(text);
 expect(home).toContain('$845,000');expect(home).toContain('/listing/home/#video-tour');expect(home).not.toContain('<iframe ');
 expect((home.match(/<img /g)||[]).length).toBe(5);
 const state=sampleView(t,sample);expect(check.checkSite(state,new Set(Array.from({length:5},(_,i)=>String(i+1).repeat(32)+".jpg"))).broken).toEqual([]);
 const art=await themes.needs(db,t);expect(art.art).toEqual(t.manifest.art);expect(art.art.ask).toContain('actual property');expect(art.images[0].size).toEqual([1600,900]);
 for(const path of ['/listing/home/#video-tour','/#visit','#photos'])expect(()=>MODELS.site.parse({cta_link:path,links:[{label:'Photos',url:path}]})).not.toThrow();
 const live=render(t,'home',homeView(state,'1','https://site.example'),{sources:['https://www.youtube-nocookie.com','https://my.matterport.com'],origin:'https://site.example'});expect(live.match(/<iframe /g)).toHaveLength(2);
 const v=sampleView(t,sample);expect(render(t,'home',homeView(v,'1','https://example.com'))).toContain('id="video-tour"');expect(render(t,'entry',entryView(v,v.entries[0],'1','https://example.com'))).toContain('id="video-tour"');
});

it('uses the shared ASCII-only heading contract without host Unicode tables',()=>{
 for(const c of headingCases)expect(Array.from(markdown(c.source,undefined,true).html.matchAll(/ id="([^"]+)"/g),m=>m[1])).toEqual(c.ids);
});
it('allocates repeated and adversarial suffixes within a bounded parser interval',()=>{
 const start=performance.now(),html=markdown('# a\n'.repeat(4000),undefined,true).html,elapsed=performance.now()-start;
 expect(html).toContain('id="a-4000"');expect(html.match(/<h1 /g)).toHaveLength(4000);expect(elapsed).toBeLessThan(150);
 const source='# a\n'+Array.from({length:2000},(_,i)=>'# a-'+(i+2)).join('\n')+'\n# a\n# a';
 const result=markdown(source,undefined,true).html;expect(result).toContain('id="a-2002"');expect(result).toContain('id="a-2003"');
});
it('keeps exactly one Listing h1 with a legal body h1, without changing other levels or flag-off rendering',()=>{
 const input=structuredClone(sample);input.items[0].data.body='# Photos\n\n## Video tour\n\n### A room';
 const pages=renderSample(t,input);
 for(const page of Object.values(pages))expect(page.match(/<h1(?: |>)/g)).toHaveLength(1);
 for(const key of ['index.html','listing/home/index.html']){
  expect(pages[key]).toContain('<h2 id="photos">Photos</h2>');expect(pages[key]).toContain('<h2 id="video-tour">');expect(pages[key]).toContain('<h3 id="a-room">');
 }
 expect(markdown('# Photos').html).toBe('<h1>Photos</h1>');
 const mini:any={manifest:{body_h1_as_h2:true},pages:{entry:'{{{entry.body_html}}}'},partials:{}};
 expect(render(mini,'entry',{entry:{body:'# Photos',body_html:bodyMarkdown('# Photos')}})).toBe('<h2>Photos</h2>');
 expect(rules('listing-page',{...t,manifest:{...t.manifest,body_h1_as_h2:'true'}},{scripts:true})).toContain('body_h1_as_h2 must be a boolean');
});
