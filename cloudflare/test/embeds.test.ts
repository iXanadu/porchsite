import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import cases from "../../spec/embed-cases.json";
import { embedURL, embedSources, unicodeHost } from "../src/embed-url";
import { bodyMarkdown, embedsOf, finishEmbeds, frameCsp, embedNotes } from "../src/embeds";
import { embedReview } from "../src/embed-review";
import { markdown } from "../src/html";
import { render } from "../src/theme";
import * as content from "../src/content";
import * as approvals from "../src/approvals";
import { handle } from "../src/routes";
import type { Env } from "../src/env";
const db=(env as unknown as Env).DB, actor="assistant:test", source="https://www.youtube-nocookie.com", form="!embed[Tour](https://youtu.be/Ab_C-123)", origin="https://site.example";
const make=(kind:string,data:any)=>content.createItem(db,actor,kind,data,undefined);
const go=(path:string,init?:RequestInit)=>handle(new Request(origin+path,init),env as unknown as Env);
beforeEach(async()=>{await db.batch(["approvals","publishes","live","revisions","items","idempotency"].map(t=>db.prepare(`DELETE FROM ${t}`)));});
async function publish(items:content.Item[]) {const a=await approvals.request(db,actor,items.map(i=>i.id),"");await approvals.decide(db,a.id,Object.fromEntries(items.map(i=>[i.id,{decision:"approve" as const}])),"",origin);}
async function signedIn() {const token="embed-owner-session", bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token))), hash=btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");await db.prepare("INSERT OR IGNORE INTO owner(id,name,user_handle,created_at) VALUES(1,'Owner','AA','2026-01-01')").run(); await db.prepare("INSERT OR REPLACE INTO sessions(token_hash,created_at,expires_at) VALUES(?,'2026-01-01','2099-01-01')").bind(hash).run();return `__Host-sk_owner=${token}`;}
it("canonicalises with browser URL semantics and rejects non-public or malformed authorities",()=>{
 for(const [a,b] of cases.valid)expect(embedURL(a,true).origin,a).toBe(b);
 for(const a of [...cases.invalid,...cases.invalid_ipv4.map(v=>"https://"+v.join("."))])expect(()=>embedURL(a,true),a).toThrow();
 for(const [a,b] of cases.providers)expect(embedURL(a).href,a).toBe(b);
 expect(()=>embedSources(["https://example.com","https://EXAMPLE.com:443/"])).toThrow();
 expect(()=>embedSources(Array(21).fill(source))).toThrow();
 expect(unicodeHost("xn--bcher-kva.example")).toBe("bücher.example");
});
it("places only standalone entry blocks and keeps code and invalid forms literal",()=>{
 const body=bodyMarkdown("Before\n"+form+"\nAfter");expect(body.indexOf("Before")).toBeLessThan(body.indexOf("<porchsite-embed")); expect(body.indexOf("<porchsite-embed")).toBeLessThan(body.indexOf("After"));
 for(const src of ["```\n"+form+"\n```","~~~\n"+form+"\n~~~","    "+form,"`"+form+"`","\\"+form,"> "+form,"- "+form,"inline "+form,form+" ","!embed[x](javascript:bad)"]) {
  expect(embedsOf(src),src).toEqual([]);expect(finishEmbeds(bodyMarkdown(src),[source],origin),src).not.toMatch(/<iframe|<a |<img/);
 }
 for(const src of ["Plain **bold**\n\ntext.","![photo](/media/hash.png)","<iframe src=x>"])expect(bodyMarkdown(src)).toBe(markdown(src).html);
 expect(markdown(form).html).not.toContain("<a ");
});
it("caps selected occurrences, not contexts; inactive templates do not spend budget",()=>{
 expect(finishEmbeds(bodyMarkdown(form),[source],origin)).toBe(cases.frame);
 const marker=bodyMarkdown(form), t:any={pages:{home:'<template>{{{body}}}</template>{{#copies}}{{{body}}}{{/copies}}'},partials:{}};
 const body=render(t,"home",{body:marker,unused:marker.repeat(30),copies:Array(14).fill({body:marker})},{sources:[source],origin});
 expect(body.match(/<iframe /g)).toHaveLength(12);expect(body.match(/<a /g)).toHaveLength(15);
 expect(render(t,"home",{body:marker,copies:[{body:marker}]})).not.toContain("<iframe");
 expect(finishEmbeds(marker,[source],source)).not.toContain("<iframe");
 expect(finishEmbeds(marker,[],origin)).toContain('<a href="https://www.youtube-nocookie.com/embed/Ab_C-123">Tour</a>');
 expect(frameCsp("default-src 'none'",[],origin)).toBe("default-src 'none'");
 expect(frameCsp("default-src 'none'",[source],origin)).toBe("default-src 'none'; frame-src "+source);
});
it("reviews exact authority and removal with ordered non-failing notes",()=>{
 const live:any=[{id:'site',kind:'site',data:{embed_sources:[]}},{id:'e',kind:'entry',data:{body:form,status:'ready'}}], proposed=live.map((r:any)=>r.kind==='site'?{...r,data:{embed_sources:[source]}}:r);
 expect(embedReview(live,proposed,proposed,origin)).toContain('You are approving the whole source');
 expect(embedReview(proposed,live,live,origin)).toContain('Its players become normal links');
 expect(embedReview(live,[{id:'site',kind:'site',data:{embed_sources:['https://xn--bcher-kva.example']}}],[],origin)).toContain('bücher.example');
 expect(embedNotes([{id:'e',body:form+'\n'+form}],[],origin)).toHaveLength(2);
 expect(embedNotes([{id:'e',body:form}],[source],origin)).toEqual([]);
});
it("publishes only approved live origins; review and preview have no frames; removal acts immediately",async()=>{
 const site=await make('site',{theme:'personal-homepage',embed_sources:[source]}), entry=await make('entry',{title:'Tour',date:'2026-10-15',body:form});
 await publish([entry]);
 let page=await go(`/journal/${entry.slug}/`);expect(await page.text()).not.toContain('<iframe');expect(page.headers.get('content-security-policy')).not.toContain('frame-src');
 const a=await approvals.request(db,actor,[site.id],''), cookie=await signedIn();
 const review=await go(`/review/${a.id}`,{headers:{Cookie:cookie}}), text=await review.text();expect(text).toContain('Add embed source');expect(text).toContain(source);expect(text).not.toContain('<iframe');expect(review.headers.get('content-security-policy')).not.toContain('frame-src');expect(review.headers.get('x-frame-options')).toBe('DENY');
 expect(await (await go(`/review/${a.id}/preview/journal/${entry.slug}/`,{headers:{Cookie:cookie}})).text()).not.toContain('<iframe');
 await approvals.decide(db,a.id,{site:{decision:'approve'}},'',origin);
 page=await go(`/journal/${entry.slug}/`);const shown=await page.text();expect(shown).toContain('<iframe');expect(shown).toContain('sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"');expect(page.headers.get('content-security-policy')).toContain('frame-src '+source);expect(page.headers.get('permissions-policy')).toContain('geolocation=()');
 const approvedPreview=await go(`/review/${a.id}/preview/journal/${entry.slug}/`,{headers:{Cookie:cookie}});expect(await approvedPreview.text()).not.toContain('<iframe');
 const publishId=(await db.prepare("SELECT MAX(id) AS id FROM publishes").first<{id:number}>())!.id;
 const changed=await content.updateItem(db,actor,site.id,site.version,{embed_sources:[]});await publish([changed]);
 page=await go(`/journal/${entry.slug}/`);expect(await page.text()).not.toContain('<iframe');expect(page.headers.get('content-security-policy')).not.toContain('frame-src');
 const restored=await go(`/review/history/${publishId}`,{headers:{Cookie:cookie}});const restoreText=await restored.text();expect(restoreText).toContain('Add embed source');expect(restoreText).not.toContain('<iframe');
 const history=await import('../src/history');await history.revert(db,publishId,'restore source',origin);expect(await (await go(`/journal/${entry.slug}/`)).text()).toContain('<iframe');
});
it("rejects self-origin during owner publication before writing live state",async()=>{
 const s=await make('site',{embed_sources:[origin]}), a=await approvals.request(db,actor,[s.id],'');
 await expect(approvals.decide(db,a.id,{site:{decision:'approve'}},'',origin)).rejects.toMatchObject({code:'invalid'});
 expect(await db.prepare("SELECT * FROM live WHERE item_id='site'").first()).toBeNull();
});

it("adds site_check notes against live authority and leaves no-embed answers unchanged",async()=>{
 const {createToolHandlers}=await import('../src/mcp'), {withToolContext}=await import('../src/tool-context');
 const handlers=createToolHandlers();
 const check=async(deep=false)=>{
   const r=await withToolContext({origin,client:'test'},()=>handlers.get('site_check')!({deep}));
   expect(r.isError).not.toBe(true);return JSON.parse(r.content[0].text);
 };
 expect(await check()).not.toHaveProperty('embed_notes');
 const site=await make('site',{embed_sources:[source]}), e=await make('entry',{title:'Video',date:'2026-10-15',body:form});
 const quick=await check();expect(quick.ok).toBe(true);expect(quick.broken).toEqual([]);expect(quick.embed_notes).toEqual([{id:e.id,url:source+'/embed/Ab_C-123',origin:source,note:'Ask the owner to approve this embed source.'}]);
 expect((await check(true)).embed_notes).toEqual(quick.embed_notes);
 await publish([site,e]);expect(await check()).not.toHaveProperty('embed_notes');
});

it("does not trust authored frames or dynamic tag names in looks",async()=>{
 const marker=bodyMarkdown(form);
 expect(finishEmbeds('<iframe src="'+source+'">ignored</iframe>'+marker,[source],origin)).toBe('<template src="'+source+'">ignored</template>'+cases.frame);
 expect(finishEmbeds('<IFRAME src="'+source+'"></IFRAME>',[source],origin)).not.toMatch(/iframe/i);
 expect(finishEmbeds('<!--><iframe src="'+source+'"></iframe>',[source],origin)).not.toMatch(/iframe/i);
 const {rules}=await import('../src/themecheck'), {THEMES}=await import('../src/themes.gen');
 const t=THEMES['personal-homepage'];
 for(const bad of ['<{{site.logo_text}} src="{{site.cta_link}}"></{{site.logo_text}}>','<if{{site.logo_text}}rame></if{{site.logo_text}}rame>','<porchsite-embed data-url="x" data-title="y"></porchsite-embed>']) {
  expect(rules('personal-homepage',{...t,pages:{...t.pages,home:bad}},{scripts:true}).some(p=>p.includes('tag names')||p.includes('iframes'))).toBe(true);
 }
});
