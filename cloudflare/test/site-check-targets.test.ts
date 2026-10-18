import { afterEach, expect, it, vi } from "vitest";
import { validate } from "../src/content";
import { checkSite, checkSiteDeep } from "../src/check";
import * as site from "../src/site";
import * as theme from "../src/theme";
import CASES from "../../spec/fixtures/site-check-targets.json";
const data = validate("site", {title:"Targets",theme:"personal-homepage",sections:["entries"],streams:[{id:"journal",title:"Journal",path:"reports"}],archive:{enabled:true,title:"All pages"}});
const entry = (id:string) => ({id,kind:"entry",slug:id,data:validate("entry",{title:id,date:"2026-10-10",body:"Full body",summary:"Summary only",...(id==="external"?{external_url:"https://external.example/?a=1&b=2"}:{})})});
const look=(home:string) => ({manifest:{},partials:{},static:{},pages:{home,archive:'<a href="/reports/a/">A</a>',entry:'<a href="/reports/b/">B</a>'}});
afterEach(()=>vi.restoreAllMocks());
it.each(CASES)('site_check_target_$name',async c=>{
 const result=await checkSiteDeep(site.view(data,c.entries.map(entry)),new Set(),look(c.home));
 expect(result.unreachable.map(x=>x.id)).toEqual(c.unreachable);
 expect(result.ok).toBe(c.unreachable.length===0);expect(result.crawl).toBeUndefined();
});
it.each([200,500])('site_check_target_listing %i: home and reached engine archive, no entry renders',async count=>{
 const home=vi.spyOn(theme,'homeView'),entryRender=vi.spyOn(theme,'entryView'),archive=vi.spyOn(site,'allArchivePage');
 const r=await checkSiteDeep(site.view(data,Array.from({length:count},(_,i)=>entry('entry-'+i))),new Set(),look('<a href="/archive/">All pages</a>'));
 expect(r).toEqual({ok:true,broken:[],empty_sections:[],unreachable:[]});
 expect(home).toHaveBeenCalledTimes(1);expect(archive).toHaveBeenCalledTimes(1);expect(entryRender).not.toHaveBeenCalled();
});
it.each([9999,10000])('site_check_target_caps links: final proof after %i nonHTTP links',async before=>{
 const home='<a href="mailto:owner@example.com">Mail</a>'.repeat(before)+'<a href="/reports/a/">A</a>'+'<a href="/missing/">Leftover</a>'.repeat(10001);
 const r=await checkSiteDeep(site.view(data,[entry('a')]),new Set(),look(home));
 if(before===9999){expect(r.ok).toBe(true);expect(r.crawl).toBeUndefined();}
 else expect(r).toMatchObject({ok:false,unreachable:[],crawl:{limit:'links',pages:1,links:10000}});
});
it.each([198,199])('site_check_target_caps pages: proof after %i missing addresses',async before=>{
 const home=Array.from({length:before},(_,i)=>`<a href="/missing-${i}/">Missing</a>`).join('')+'<a href="/reports/">Listing</a>';
 const r=await checkSiteDeep(site.view(data,[entry('a')]),new Set(),look(home));
 if(before===198){expect(r.ok).toBe(true);expect(r.crawl).toBeUndefined();}
 else expect(r).toMatchObject({ok:false,unreachable:[],crawl:{limit:'pages',pages:200}});
});
it('site_check_target_quick: broken remains failure; default and empty target skip rendering',async()=>{
 const spy=vi.spyOn(theme,'homeView'),v=site.view({...data,cta_link:'/missing/'},[]);
 const quick=checkSite(v,new Set()),deep=await checkSiteDeep(v,new Set(),look('<a href="/reports/a/">A</a>'));
 expect(deep).toEqual({...quick,unreachable:[]});expect(deep.ok).toBe(false);expect(spy).not.toHaveBeenCalled();
});
it('site_check_target_redirect: a legacy-prefix self-redirect is not a renderable target',async()=>{
 const d=validate('site',{...data,streams:[{id:'journal',title:'Journal',path:'e'}]});
 const r=await checkSiteDeep(site.view(d,[entry('a')]),new Set(),look('<a href="/journal/a">Moved</a><a href="/e/a/">Cycle</a>'));
 expect(r.ok).toBe(false);expect(r.crawl).toBeUndefined();expect(r.unreachable.map(x=>x.id)).toEqual(['a']);
});
