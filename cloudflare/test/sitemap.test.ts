import {THEMES} from '../src/themes.gen';
import * as themes from '../src/themes';
import {env} from 'cloudflare:workers';
import {beforeEach,expect,it} from 'vitest';
import cases from '../../spec/sitemap-cases.json';
import robotsCases from '../../spec/robots-cases.json';
import {sitemap,SITEMAP_HEADERS,robots} from '../src/sitemap';
import {view} from '../src/site';
import {MODELS} from '../src/models';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import {handle} from '../src/routes';
import type {Env} from '../src/env';
const db=(env as unknown as Env).DB,origin='https://site.example',actor='assistant:test';
const go=(path:string,method='GET')=>handle(new Request(origin+path,{method}),env as unknown as Env);
const make=(kind:string,data:any)=>content.createItem(db,actor,kind,data,undefined);
async function publish(items:content.Item[]){const a=await approvals.request(db,actor,items.map(i=>i.id),'');await approvals.decide(db,a.id,Object.fromEntries(items.map(i=>[i.id,{decision:'approve' as const}])),'',origin);}
beforeEach(async()=>{await db.batch(['site_embed_sources','approvals','publishes','live','revisions','items','idempotency','themes'].map(t=>db.prepare(`DELETE FROM ${t}`)));});
it('shares exact XML, UTC approval dates, visibility, aggregate dates and fallback cases',()=>{
 const v=view(MODELS.site.parse(cases.site),cases.rows.map(r=>({...r,slug:('slug' in r?r.slug:null)??null,data:(MODELS as any)[r.kind].parse(r.data)})));v.approved_at=cases.approved_at;
 const rows=cases.expected.map(r=>`<url><loc>${origin}${r.path}</loc><lastmod>${r.lastmod}</lastmod></url>\n`).join('');
 expect(sitemap(v,origin)).toBe('<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+rows+'</urlset>\n');
 const fallback=sitemap(v,origin,false);expect((fallback.match(/<loc>/g)||[]).length).toBe(2);expect(fallback).not.toContain('/outside/');expect(fallback).not.toContain('/draft/');
 v.approved_at={};expect(sitemap(v,origin)).not.toContain('<lastmod>');
 expect(robots(origin)).toBe(robotsCases.allowed);expect(robots(origin,true)).toBe(robotsCases.disabled);
});
it('serves only published reachable paths, unchanged on draft edits, with feed cache and HEAD parity',async()=>{
 const site=await make('site',{theme:'personal-homepage',streams:[{id:'journal',title:'Journal',path:'writing'},{id:'empty',title:'Empty'}]}),local=await make('entry',{title:'Local',date:'1999-01-01',tags:['alpha']}),external=await make('entry',{title:'External',external_url:'https://outside.example/article',date:'2000-01-01',tags:['external-only']}),hidden=await make('entry',{title:'Hidden',date:'2099-01-01'});
 await publish([site,local,external]);
 const r=await go('/sitemap.xml'),body=await r.text();expect(r.status).toBe(200);for(const [k,v]of Object.entries(SITEMAP_HEADERS))expect(r.headers.get(k)).toBe(v);
 const locs=Array.from(body.matchAll(/<loc>([^<]+)<\/loc>/g),m=>m[1]);for(const loc of locs)expect((await go(loc.slice(origin.length))).status,loc).toBe(200);
 expect(locs).toContain(origin+'/empty/');expect(locs).toContain(origin+String((await db.prepare('SELECT slug FROM items WHERE id=?').bind(local.id).first<any>()).slug).replace(/^/,'/writing/')+'/');
 expect(body).not.toContain(hidden.slug!);expect(body).not.toContain(external.slug!+'/');expect(body).not.toMatch(/\/review|\/setup|\/login|outside.example/);expect(body).not.toContain('<lastmod>1999-01-01</lastmod>');
 const at=await db.prepare('SELECT published_at FROM live WHERE item_id=?').bind(local.id).first<any>();expect(body).toContain(`<lastmod>${new Date(at.published_at).toISOString().slice(0,10)}</lastmod>`);
 await content.updateItem(db,actor,local.id,local.version,{body:'Not approved'},undefined);
 expect(await (await go('/sitemap.xml')).text()).toBe(body);
 const head=await go('/sitemap.xml','HEAD');expect(head.status).toBe(200);expect(await head.text()).toBe('');expect(head.headers.get('content-type')).toBe(r.headers.get('content-type'));expect(head.headers.get('cache-control')).toBe((await go('/writing/feed.xml')).headers.get('cache-control'));
 expect(await (await go('/robots.txt')).text()).toBe(robots(origin));
});
it('omits archive/tag routes when the named look is unavailable',async()=>{
 const site=await make('site',{theme:'unavailable-look'}),entry=await make('entry',{title:'Local',date:'2026-10-10',tags:['tag']});await publish([site,entry]);
 const body=await (await go('/sitemap.xml')).text();expect((body.match(/<loc>/g)||[]).length).toBe(2);expect(body).not.toContain('/tags/');
});

it('includes reachable installed/private look archives, and recognises bundled aliases without a query',async()=>{
 expect(themes.isBuiltIn('classic')).toBe(true);expect(themes.isBuiltIn('fixture-look')).toBe(false);
 const base=THEMES['personal-homepage'],t={...base,manifest:{...base.manifest,name:'fixture-look'}};
 await db.prepare("INSERT INTO themes(name,version,package,sha256,installed_at,installed_by,source) VALUES('fixture-look','1',?,'fixture','2026','owner','private')").bind(JSON.stringify(t)).run();
 const site=await make('site',{theme:'fixture-look'}),entry=await make('entry',{title:'Local',date:'2026-10-10',tags:['tag']});await publish([site,entry]);
 const body=await(await go('/sitemap.xml')).text();expect(body).toContain(origin+'/journal/</loc>');expect(body).toContain(origin+'/journal/tags/tag/</loc>');expect((await go('/journal/tags/tag/')).status).toBe(200);
});
