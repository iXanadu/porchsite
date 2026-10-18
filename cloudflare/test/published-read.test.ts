import {env} from 'cloudflare:workers';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import type {Env} from '../src/env';
import * as read from '../src/read-keys';
import * as content from '../src/content';
import * as approvals from '../src/approvals';
import * as published from '../src/published-read';
import * as site from '../src/site';
import worker from '../src/index';
import {handle} from '../src/routes';
import {BLANK} from '../src/privacy';
import {createToolHandlers} from '../src/mcp';
import {withToolContext} from '../src/tool-context';
import {readNormalize} from '../src/read-unicode';
import UNICODE from '../../spec/fixtures/read-unicode.json';
const e=env as unknown as Env,db=e.DB,origin='https://site.example',actor='assistant:test';
const ctx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
beforeEach(async()=>{
 vi.restoreAllMocks();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
 const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
 for(const {name} of rows.results)if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith('sqlite_')&&!name.startsWith('d1_'))await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare('INSERT INTO auth_state(id) VALUES(1)').run();
});
afterEach(()=>vi.useRealTimers());
async function publish(item:content.Item){await approvals.publishNow(db,[{id:item.id,version:item.version}],'',origin);}
async function fixture(n=3){
 const one=await content.createItem(db,actor,'site',{title:'Reader site',theme:'personal-homepage',archive:{enabled:true,title:'All entries'},streams:[{id:'one',title:'One'},{id:'two',title:'Two'}]},undefined);await publish(one);
 const entries:content.Item[]=[];
 for(let i=0;i<n;i++){const entry=await content.createItem(db,actor,'entry',{title:'Page '+i,date:'2026-10-17',stream:i%2?'two':'one',tags:[i%2?'other':'report'],body:i===0?'Café woodwork. '+ '🦊'.repeat(260):'Published text '+i},undefined);await publish(entry);entries.push(entry);}
 const made=await read.create(db,'Reader'),principal={...await read.lookup(db,made.token),origin};return {one,entries,made,principal};
}
async function rpc(token:string,name:string,args:any={},fallback=false){
 const r=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:fallback?'application/json':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,...(fallback?{_meta:{test:true}}:{})}})}),e,ctx);
 const text=await r.text(),out=JSON.parse(text.startsWith('{')?text:(text.split('\n').find(x=>x.startsWith('data:'))??'data:{}').slice(5));return {response:r,out,value:out.result?.content?.[0]?JSON.parse(out.result.content[0].text):null};
}
it.each([false,true])('ag_read_tools_live_only: all transports and writer catalog, fallback=%s',async(fallback)=>{
 const {one,entries,made,principal}=await fixture();
 const pending=await content.updateItem(db,actor,entries[0].id,entries[0].version,{body:'DRAFT_VERSION_CANARY'});await approvals.request(db,actor,[pending.id],'Pending');
 const draft=await content.createItem(db,actor,'entry',{title:'HIDDEN_DRAFT_CANARY',body:'Hidden draft body',date:'2026-10-17',status:'draft'},undefined);await publish(draft);
 const privateCard=await content.createItem(db,actor,'card',{name:'HIDDEN_CARD_CANARY',description:'HIDDEN_CARD_TEXT',visibility:'private'},undefined);await publish(privateCard);
 const mention=await content.createItem(db,actor,'card',{name:'Visible mention',description:'Visible mention text',visibility:'mention',link:'https://example.com/HIDDEN_MENTION_LINK'},undefined);await publish(mention);
 const path='/one/'+entries[0].slug+'/',get=await rpc(made.token,'page_get',{path:path+'index.md'},fallback);expect(get.out.result.isError).not.toBe(true);expect(get.value.path).toBe(path);
 const md=await handle(new Request(origin+path+'index.md'),e);expect(get.value.markdown).toBe(await md.text());expect(get.value.tags).toEqual(['report']);expect(get.value.date).toBe('2026-10-17');
 const state=await rpc(made.token,'site_state',{guide:{}},fallback),list=await rpc(made.token,'pages_list',{},fallback),search=await rpc(made.token,'search',{query:'CAFE\u0301 woodwork'},fallback);
 expect(state.value.pages).toEqual(list.value.pages);expect(search.value.results.some((r:any)=>r.path===path)).toBe(true);
 const combined=JSON.stringify([get,state.value,list.value,search.value]);for(const text of ['DRAFT_VERSION_CANARY','HIDDEN_DRAFT_CANARY','HIDDEN_CARD_CANARY','HIDDEN_CARD_TEXT','HIDDEN_MENTION_LINK'])expect(combined).not.toContain(text);
 expect(get.response.headers.get('Cache-Control')).toBe('private, no-store, no-transform');
 expect(await published.pagesList(db,{stream:'missing'},principal)).toEqual({pages:[],next_cursor:null});expect(await published.pagesList(db,{tag:'missing'},principal)).toEqual({pages:[],next_cursor:null});
 const hidden=await content.updateItem(db,actor,'site',one.version,{private:true});await publish(hidden);
 expect((await rpc(made.token,'page_get',{path},fallback)).value.markdown).toContain('Café woodwork');
 // Slice C replaces B's no-HTTP checkpoint with published reader HTML only.
 const privateHTML=await handle(new Request(origin+path,{headers:{Authorization:'Bearer '+made.token,'If-None-Match':'*'}}),e);expect(privateHTML.status).toBe(200);expect(await privateHTML.text()).toContain('Café woodwork');expect(privateHTML.headers.get('Cache-Control')).toBe('private, no-store, no-transform');for(const name of ['ETag','Last-Modified','Content-Signal'])expect(privateHTML.headers.has(name)).toBe(false);
 for(const headers of ([{},{Authorization:'Bearer psk_unknown'}] as Record<string,string>[])){const denied=await handle(new Request(origin+path,{headers}),e);expect(denied.status).toBe(404);expect(await denied.text()).not.toContain('Café woodwork');}
 const writer=await withToolContext({client:'writer',clientId:'writer-1',origin},()=>createToolHandlers().get('page_get')!({path}));expect(writer.isError).not.toBe(true);
});
it('ag_read_cursor: bounded continuation binds principal, scope, filters and current visible corpus',async()=>{
 const {entries,principal}=await fixture(23),first=await published.pagesList(db,{},principal),state=await published.state(db,{},principal);expect(first.pages).toHaveLength(20);expect(first.next_cursor).toBeTruthy();expect(state.next_cursor).toBe(first.next_cursor);
 const next=await published.pagesList(db,{cursor:first.next_cursor},principal);const paths=[...first.pages,...next.pages].map(p=>p.path);expect(new Set(paths).size).toBe(paths.length);expect(paths).toEqual([...paths].sort());expect(next.next_cursor).toBeNull();
 const other=await read.create(db,'Other'),foreign={...await read.lookup(db,other.token),origin};
 for(const [args,props] of [[{cursor:first.next_cursor},foreign],[{cursor:first.next_cursor,tag:'report'},principal],[{cursor:first.next_cursor},{client:'writer',clientId:'writer',origin}]] as any[])await expect(published.pagesList(db,args,props)).rejects.toMatchObject({code:'invalid'});
 const staged=await content.updateItem(db,actor,entries[0].id,entries[0].version,{body:'Unapproved cursor change'});expect((await published.pagesList(db,{},principal)).next_cursor).toBe(first.next_cursor);
 const hidden=await content.createItem(db,actor,'card',{name:'Invisible cursor input',description:'Private fixture description',visibility:'private'},undefined);await publish(hidden);expect((await published.pagesList(db,{},principal)).next_cursor).toBe(first.next_cursor);
 await publish(staged);await expect(published.pagesList(db,{cursor:first.next_cursor},principal)).rejects.toMatchObject({code:'cursor_stale'});
});
it('ag_read_visible_timestamps: private cards, draft-status entries and overflow notes do not change reader dates',async()=>{
 const {entries}=await fixture(),notes:content.Item[]=[];for(let i=0;i<13;i++){const note=await content.createItem(db,actor,'note',{text:'Visible note '+i,date:'2026-09-'+String(i+1).padStart(2,'0')},undefined);await publish(note);notes.push(note);}await db.prepare("UPDATE live SET published_at='2026-10-17T10:00:00.000Z'").run();
 const before=await site.liveView(db),hidden=await content.createItem(db,actor,'card',{name:'Invisible date row',description:'Private fixture description',visibility:'private'},undefined);await publish(hidden);await db.prepare("UPDATE live SET published_at='2030-01-01T00:00:00.000Z' WHERE item_id=?").bind(hidden.id).run();
 const draft=await content.createItem(db,actor,'entry',{title:'Invisible status date',date:'2026-10-17',status:'draft'},undefined);await publish(draft);await db.prepare("UPDATE live SET published_at='2031-01-01T00:00:00.000Z' WHERE item_id=?").bind(draft.id).run();
 await db.prepare("UPDATE live SET published_at='2032-01-01T00:00:00.000Z' WHERE item_id=?").bind(notes[0].id).run();
 const after=await site.liveView(db),discovery=await site.liveView(db,true);expect(after.updated).toBe(before.updated);expect(discovery.approved_at).not.toHaveProperty(hidden.id);expect(discovery.approved_at).not.toHaveProperty(draft.id);expect(discovery.approved_at).not.toHaveProperty(notes[0].id);expect(discovery.approved_at).toHaveProperty(entries[0].id);
});
it('ag_read_invalid_inputs: refuse before content lookup and never follow owner/media/external paths',async()=>{
 const {principal}=await fixture(),load=vi.spyOn(site,'liveView');
 for(const path of ['https://example.com/','//example.com/','/a/../','/a/%2f/','/a/%5c/','/a/#x','/archive/?tag=x%0A','/archive/?sort=date&sort=stream','/archive/?unknown=1']){load.mockClear();await expect(published.pageGet(db,{path},principal)).rejects.toMatchObject({code:'invalid'});expect(load).not.toHaveBeenCalled();}
 for(const args of [{query:''},{query:' '.repeat(20)},{query:'🦊'.repeat(201)},{query:'x',cursor:'ag2_bad'},{query:'x',limit:51}]){load.mockClear();await expect(published.search(db,args,principal)).rejects.toMatchObject({code:'invalid'});expect(load).not.toHaveBeenCalled();}
 for(const path of ['/review/','/media/example.jpg','/missing/','/mcp/'])await expect(published.pageGet(db,{path},principal)).rejects.toMatchObject({code:'not_found'});
 const found=await published.search(db,{query:'🦊'.repeat(200)},principal);expect(found.results.length).toBeGreaterThan(0);expect(found.results.every(r=>[...r.excerpt].length<=240)).toBe(true);
});
it.each(['page_get','pages_list','search'])('ag_read_revocation_race %s denies a completed projection before delivery',async(name)=>{
 const {entries,made,principal}=await fixture(),method={page_get:'pageGet',pages_list:'pagesList',search:'search'}[name] as 'pageGet'|'pagesList'|'search';
 const original=published[method];vi.spyOn(published,method).mockImplementation(async(...args:any[])=>{const value=await (original as any)(...args);await read.revoke(db,made.id);return value;});
 const args=name==='page_get'?{path:'/one/'+entries[0].slug+'/'}:name==='search'?{query:'woodwork'}:{};
 const result=await withToolContext(principal,()=>createToolHandlers().get(name)!(args));expect(result.isError).toBe(true);expect(JSON.stringify(result)).not.toContain('Café');expect(JSON.stringify(result)).not.toContain('Reader site');
});

it('ag_read_unicode: shared fixed normalization is independent of runtime Unicode and locale',()=>{for(const [source,expected] of UNICODE)expect(readNormalize(source)).toBe(expected);});

it('ag_read_since: strict UTC timestamps compare fractions and filter only local entry pages',async()=>{
 const {entries,principal}=await fixture();await db.prepare("UPDATE live SET published_at='2026-10-16T00:00:00Z'").run();
 await db.prepare("UPDATE live SET published_at='2026-10-17T12:00:00.0001Z' WHERE item_id=?").bind(entries[0].id).run();
 const rows=await published.pagesList(db,{since:'2026-10-17t12:00:00.00009z'},principal);expect(rows.pages.map(p=>p.path)).toEqual(['/one/'+entries[0].slug+'/']);
 expect((await published.pagesList(db,{since:'2026-10-17T12:00:00.0001Z'},principal)).pages).toEqual([]);
 const load=vi.spyOn(site,'liveView');for(const since of ['2026-10-17T12:00:00Z\n','2026-02-30T00:00:00Z','2026-10-17T12:00:00+00:00']){load.mockClear();await expect(published.pagesList(db,{since},principal)).rejects.toMatchObject({code:'invalid'});expect(load).not.toHaveBeenCalled();}
});

it.each(['page_get','pages_list','search'])('ag_read_publication_race %s never returns a just-unpublished body',async(name)=>{
 const {entries,principal}=await fixture(),original=site.liveView;let calls=0;
 vi.spyOn(site,'liveView').mockImplementation(async(...args:Parameters<typeof site.liveView>)=>{const value=await original(...args);if(++calls===1)await db.prepare('DELETE FROM live WHERE item_id=?').bind(entries[0].id).run();return value;});
 const reading=name==='page_get'?published.pageGet(db,{path:'/one/'+entries[0].slug+'/'},principal):name==='pages_list'?published.pagesList(db,{},principal):published.search(db,{query:'woodwork'},principal);
 if(name==='page_get')await expect(reading).rejects.toMatchObject({code:'not_found'});
 else{const result=await reading;expect(JSON.stringify(result)).not.toContain('/one/'+entries[0].slug+'/');expect(JSON.stringify(result)).not.toContain('Café');expect(calls).toBe(4);}
});
it.each(['site_state','pages_list','search','page_get'])('ag_read_cursorless_restart: %s rebuilds across a minute',async(name)=>{
 const {entries,principal}=await fixture(),original=site.liveView;let calls=0;
 vi.spyOn(site,'liveView').mockImplementation(async(...args:Parameters<typeof site.liveView>)=>{const value=await original(...args);if(++calls===2)vi.setSystemTime(new Date('2026-10-17T12:01:00Z'));return value;});
 const result=name==='site_state'?await published.state(db,{},principal):name==='pages_list'?await published.pagesList(db,{},principal):name==='search'?await published.search(db,{query:'woodwork'},principal):await published.pageGet(db,{path:'/one/'+entries[0].slug+'/'},principal);
 expect(calls).toBe(4);expect(JSON.stringify(result)).toContain(name==='page_get'?'Café':'/one/'+entries[0].slug+'/');
});
it('ag_read_cursorless_restart: supplied cursor stays strict across a minute',async()=>{
 const {principal}=await fixture(3),first=await published.pagesList(db,{limit:1},principal),original=site.liveView;let calls=0;expect(first.next_cursor).toBeTruthy();
 vi.spyOn(site,'liveView').mockImplementation(async(...args:Parameters<typeof site.liveView>)=>{const value=await original(...args);if(++calls===2)vi.setSystemTime(new Date('2026-10-17T12:01:00Z'));return value;});
 await expect(published.pagesList(db,{limit:1,cursor:first.next_cursor},principal)).rejects.toMatchObject({code:'cursor_stale'});expect(calls).toBe(2);
});
it('ag_read_cursorless_restart: repeated clock races fail bounded with content_changed',async()=>{
 const {principal}=await fixture(),original=site.liveView;let calls=0;
 vi.spyOn(site,'liveView').mockImplementation(async(...args:Parameters<typeof site.liveView>)=>{const value=await original(...args);if(++calls%2===0)vi.setSystemTime(Date.now()+60000);return value;});
 await expect(published.pagesList(db,{},principal)).rejects.toMatchObject({code:'content_changed'});expect(calls).toBe(4);
});
