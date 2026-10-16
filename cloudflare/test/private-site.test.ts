// PV-1/OR-1 acceptance: paired with server/tests/app/test_private_site.py.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import * as owner from "../src/owner";
import * as content from "../src/content";
import * as approvals from "../src/approvals";
import * as importer from "../src/importer";
import * as media from "../src/media";
import * as site from "../src/site";
import * as privacy from "../src/privacy";
import { BLANK, livePrivate } from "../src/privacy";
import { handle } from "../src/routes";
import worker from "../src/index";
import { SoftKey } from "./softkey";
const e = env as unknown as Env, db=e.DB, origin="https://site.example", who="assistant:test";
class Browser {
  jar = new Map<string,string>();
  async at(path:string, init:RequestInit={}) {
    const r=await handle(new Request(origin+path,{...init,headers:{...(init.headers as Record<string,string>),Cookie:[...this.jar].map(([k,v])=>`${k}=${v}`).join("; ")}}),e);
    for(const header of r.headers.getSetCookie()) {const m=/^([^=;]+)=([^;]*)/.exec(header);if(m)this.jar.set(m[1],m[2]);}
    return r;
  }
  post(path:string,body:unknown={}) {return this.at(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});}
  async options(path:string,body:unknown={}) {const r=await this.post(path,body);expect(r.status,await r.clone().text()).toBe(200);return (await r.json() as any).options;}
}
async function publish(ids:string[]) {const a=await approvals.request(db,who,ids,"");await approvals.decide(db,a.id,Object.fromEntries(ids.map(id=>[id,{decision:"approve" as const} ])),"");return a;}
async function fixture(privateMode=true) {
 const browser=new Browser(),key=await SoftKey.make();
 const options=await browser.options("/setup/options",{code:e.SETUP_CODE,name:"owner"});
 expect((await browser.post("/setup/verify",await key.create(options,origin))).status).toBe(200);
 const bytes=new Uint8Array(64).fill(7);bytes.set([255,216,255,224]);
 const picture=await media.store(db,bytes,"image/jpeg",who);
 const item=await content.createItem(db,who,"site",{title:"Hidden handbook",theme:"personal-homepage",private:privateMode,hero:picture,hero_alt:"Example picture",streams:[{id:"guide",title:"Guides",dated_addresses:false}]},undefined);
 const entry=await content.createItem(db,who,"entry",{stream:"guide",title:"Published guide",date:"2026-10-16",body:"Private page body.",tags:["guide"]},undefined);
 await publish([item.id,entry.id]);
 return {browser,key,item,entry,picture};
}
async function reader() {
 const browser=new Browser(),key=await SoftKey.make(),invite=await owner.createReaderInvite(db,"Reader");
 const options=await browser.options(`/invite/${invite.token}/options`);
 const response=await browser.post(`/invite/${invite.token}/verify`,await key.create(options,origin));
 expect(response.status,await response.clone().text()).toBe(200);expect((await response.json() as any).reader).toBe(true);
 return {browser,key,invite};
}
async function blank(r:Response) {expect(r.status).toBe(404);expect(r.headers.get("Cache-Control")).toBe("private, no-store");expect(r.headers.get("X-Robots-Tag")).toBe("noindex");expect(r.headers.has("Location")).toBe(false);expect(await r.text()).toBe(BLANK);}
beforeEach(async()=>{
 const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{name:string}>();
 for(const {name} of rows.results) if(/^[a-z][a-z_]*$/.test(name)&&!name.startsWith("sqlite_")&&!name.startsWith("d1_")) await db.prepare(`DELETE FROM ${name}`).run();
 await db.prepare("INSERT INTO auth_state (id) VALUES (1)").run();
});
describe("private sites",()=>{
 it("refuses a private not-found render even when dispatch deliberately skips its gate",async()=>{
  await fixture();
  const gate=vi.spyOn(privacy,"access").mockResolvedValue({isPrivate:true,gated:false,response:null});
  const render=vi.spyOn(site,"liveView").mockImplementation(async()=>{throw Error("Private view was constructed");});
  try {await blank(await new Browser().at("/deliberately-unrouted"));expect(render).not.toHaveBeenCalled();}
  finally {gate.mockRestore();render.mockRestore();}
 });

 it("gates hits, misses, discovery, redirects and owner pages before a live view or media lookup (1–5,11–13)",async()=>{
  const {picture}=await fixture(),visitor=new Browser();
  for(const path of ["/","/guide/published-guide/","/guide/missing/","/sitemap.xml","/guide/feed.xml","/missing/feed.xml","/guide/search.json",picture,"/media/00000000000000000000000000000000.jpg","/guide/tags/guide/","/review","/review/write","/guide/published-guide","/e/published-guide/","/loginx","/login/","/.well-known/x","/oauth/x","/upload/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/extra","/passkey/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x","/setup/","/recover/","/invite/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","/invite/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","/login/missing","/setup/missing","/recover/missing","/invite/missing","/passkey/missing","/upload/missing","/oauth/missing","/.well-known/missing","/login/options","/setup/verify","/recover/options","/invite/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/verify","/passkey/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/options","/invite/cccccccccccccccccccccccccccccccc/extra"]) {
   await blank(await visitor.at(path));const head=await visitor.at(path,{method:"HEAD"});expect(head.status).toBe(404);expect(await head.text()).toBe("");expect(head.headers.get("Cache-Control")).toBe("private, no-store");
  }
  const robots=await visitor.at("/robots.txt");expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  // A gate without any content/lookup methods: only its minimal state query may run.
  const protectedDb = {prepare(sql:string) {if(sql.includes("site_fields")) return db.prepare(sql);throw Error("Content lookup before gate: "+sql);}} as D1Database;
  expect((await handle(new Request(origin+picture),{...e,DB:protectedDb})).status).toBe(404);
 });
 it("keeps reader roles separate, refuses owner writes and never reuses cached content (6–10,14b,19–22)",async()=>{
  const {picture}=await fixture(),r=await reader(),visitor=new Browser();
  expect(r.browser.jar.has(owner.SESSION_COOKIE)).toBe(false);expect(r.browser.jar.has(owner.READER_COOKIE)).toBe(true);
  expect(await db.prepare("SELECT count(*) n FROM passkeys").first("n")).toBe(1);
  expect(await db.prepare("SELECT count(*) n FROM reader_passkeys").first("n")).toBe(1);
  for(const path of ["/","/guide/published-guide/","/sitemap.xml","/guide/feed.xml","/guide/search.json",picture]) {
   const shown=await r.browser.at(path);expect(shown.status,path).toBe(200);expect(shown.headers.get("Cache-Control")).toBe("private, no-store");
   await blank(await visitor.at(path,{headers:{"If-None-Match":"\"cached\"","If-Modified-Since":"Wed, 01 Jan 2025 00:00:00 GMT"}}));
  }
  for(const path of ["/review","/review/write","/review/history","/review/stats","/review/assistants","/review/passkeys","/review/import","/review/readers","/review/example/preview","/authorize"]) {
   for(const method of ["GET","POST"]) {const res=await r.browser.at(path,{method});expect(res.status,path).toBe(303);expect(res.headers.get("Location")).toBe("/");}
  }
  const login=await r.browser.options("/login/options");expect(login.allowCredentials??[]).toEqual([]);
  const response=await r.browser.post("/login/verify",await r.key.get(login,origin));expect((await response.json() as any).reader).toBe(true);
  await owner.revokeReader(db,r.invite.id);
  for(const path of ["/","/guide/published-guide/","/sitemap.xml","/guide/feed.xml","/guide/search.json",picture]) await blank(await r.browser.at(path,{headers:{"If-None-Match":"\"cached\"","If-Modified-Since":"Wed, 01 Jan 2025 00:00:00 GMT"}}));
 });
 it("uses approved exact-version fields and restores public output after an approved off change (14–18)",async()=>{
  const f=await fixture(false),visitor=new Browser();
  const draft=await content.updateItem(db,who,"site",f.item.version,{private:true},undefined);
  expect(await livePrivate(db)).toBe(false);expect((await visitor.at("/")).status).toBe(200);
  const enabling=await approvals.request(db,who,[draft.id],"");expect(await (await f.browser.at("/review/"+enabling.id)).text()).toContain("Passkeys will be required to read this site.");await approvals.decide(db,enabling.id,{site:{decision:"approve"}},"");expect(await livePrivate(db)).toBe(true);await blank(await visitor.at("/"));
  for(const table of ["items","revisions","live"]) {
   const sql=table==="items"?"SELECT data FROM items WHERE id='site'":`SELECT data FROM ${table} WHERE item_id='site'`;
   for(const row of (await db.prepare(sql).all<{data:string}>()).results) expect(Object.hasOwn(JSON.parse(row.data),"private")).toBe(false);
  }
  const off=await content.updateItem(db,who,"site",draft.version,{private:false},undefined);const request=await approvals.request(db,who,[off.id],"");
  expect(await (await f.browser.at("/review/"+request.id)).text()).toContain("This makes the site public.");
  await approvals.decide(db,request.id,{site:{decision:"approve"}},"");
  expect((await visitor.at("/")).status).toBe(200);expect(await livePrivate(db)).toBe(false);
  expect((await visitor.at(f.picture)).headers.get("Cache-Control")).toContain("public");
  expect(await (await visitor.at("/robots.txt")).text()).toContain("Allow");
  const count=await db.prepare("SELECT count(*) n FROM media").first("n");
  await expect(importer.importFile(db,JSON.stringify({porchsite_import:1,items:[{kind:"site",data:{private:false}}],images:{bad:"invalid"}}))).rejects.toMatchObject({code:"invalid"});
  expect(await db.prepare("SELECT count(*) n FROM media").first("n")).toBe(count);
 });
 it("creates invites through owner CSRF forms and expires/spends/cancels them (23–26)",async()=>{
  const f=await fixture();const page=await (await f.browser.at("/review/readers")).text();const csrf=/name="csrf" value="([^"]+)"/.exec(page)![1];
  const bad=await f.browser.at("/review/readers",{method:"POST",body:new URLSearchParams({name:"Reader",csrf:"wrong"})});expect(bad.status).toBe(403);
  const made=await f.browser.at("/review/readers",{method:"POST",body:new URLSearchParams({name:"Reader",csrf})});expect(await made.text()).toContain("/invite/");
  const r=await reader();expect(await owner.listReaders(db)).toHaveLength(2);
  let listing=await (await f.browser.at("/review/readers")).text();
  for(const text of ["Unused invitations","Expires ","Cancel invitation","Added ","Not signed in yet",'class="warn" name="action" value="revoke">Remove Reader'])expect(listing).toContain(text);
  await db.prepare("UPDATE reader_passkeys SET last_used_at='2026-10-16T12:00:00Z' WHERE reader_id=?").bind(r.invite.id).run();
  listing=await (await f.browser.at("/review/readers")).text();expect(listing).toContain("Last signed in October 16, 2026");
  const invitePage=await new Browser().at(`/invite/${r.invite.token}`);expect(invitePage.headers.get("Referrer-Policy")).toBe("no-referrer");expect(await invitePage.text()).toContain('history.replaceState(null,"","/login")');
  expect((await new Browser().post(`/invite/${r.invite.token}/options`)).status).toBe(410);
  const expired=await owner.createReaderInvite(db,"Expired");await db.prepare("UPDATE reader_invites SET expires_at='2000' WHERE reader_id=?").bind(expired.id).run();expect((await new Browser().post(`/invite/${expired.token}/options`)).status).toBe(410);
  const cancelled=await owner.createReaderInvite(db,"Cancelled");await owner.revokeInvite(db,cancelled.id);expect((await new Browser().post(`/invite/${cancelled.token}/options`)).status).toBe(410);
 });
 it("revokes sessions immediately, refuses stale invite completion, and leaves anonymous collection empty (14c,22b,27–28)",async()=>{
  await fixture();const r=await reader();await owner.revokeReader(db,r.invite.id);await blank(await r.browser.at("/"));
  const login=await r.browser.options("/login/options");expect((await r.browser.post("/login/verify",await r.key.get(login,origin))).status).toBe(403);
  const pending=await owner.createReaderInvite(db,"Pending"),browser=new Browser(),key=await SoftKey.make();const options=await browser.options(`/invite/${pending.token}/options`);
  await owner.revokeReader(db,pending.id);expect((await browser.post(`/invite/${pending.token}/verify`,await key.create(options,origin))).status).toBe(403);
  const count=await db.prepare("SELECT count(*) n FROM pageviews").first("n");expect((await new Browser().at("/collect",{method:"POST",headers:{"User-Agent":"Mozilla/5.0 (test reader)","CF-Connecting-IP":"192.0.2.20"},body:JSON.stringify({t:"pv",id:"private-view-0001",p:"/",k:"home"})})).status).toBe(204);expect(await db.prepare("SELECT count(*) n FROM pageviews").first("n")).toBe(count);
 });
 it("recovers atomically, fences stale owner/reader logins and adds, keeps reader keys, and allows fresh adds (22b,33–40)",async()=>{
  const f=await fixture(),r=await reader();const ownerCookie=f.browser.jar.get(owner.SESSION_COOKIE)!;
  const staleLogin=new Browser(),login=await staleLogin.options("/login/options");const loginResponse=await f.key.get(login,origin);
  const link=await owner.createPasskeyLink(db),adding=new Browser(),added=await SoftKey.make(),addOptions=await adding.options(`/passkey/${link.token}/options`);
  const recovery=new Browser(),fresh=await SoftKey.make(),code="a".repeat(32);await owner.issueRecoveryCode(db,code);
  const options=await recovery.options("/recover/options",{code});
  // Recovery works even if every old passkey was lost.
  await db.prepare("DELETE FROM passkeys").run();
  expect((await recovery.post("/recover/verify",await fresh.create(options,origin))).status).toBe(200);
  const old=new Browser();old.jar.set(owner.SESSION_COOKIE,ownerCookie);await blank(await old.at("/"));await blank(await r.browser.at("/"));
  expect((await staleLogin.post("/login/verify",loginResponse)).status).toBe(403);
  expect((await adding.post(`/passkey/${link.token}/verify`,await added.create(addOptions,origin))).status).toBe(403);
  expect(await db.prepare("SELECT count(*) n FROM passkeys").first("n")).toBe(1);expect(await db.prepare("SELECT count(*) n FROM passkey_links").first("n")).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM reader_passkeys").first("n")).toBe(1);
  const readerLogin=await r.browser.options("/login/options");expect((await r.browser.post("/login/verify",await r.key.get(readerLogin,origin))).status).toBe(200);
  const freshLink=await owner.createPasskeyLink(db),newKey=await SoftKey.make(),newBrowser=new Browser();const freshOptions=await newBrowser.options(`/passkey/${freshLink.token}/options`);
  expect((await newBrowser.post(`/passkey/${freshLink.token}/verify`,await newKey.create(freshOptions,origin))).status).toBe(200);
  expect((await new Browser().post("/recover/options",{code})).status).toBe(403);
 });
 it("gives one recovery winner, invalidates replaced/expired codes, and keeps setup closed (7,35–38)",async()=>{
  const empty=await new Browser().at("/recover");expect(empty.status).toBe(409);await fixture();
  await owner.issueRecoveryCode(db,"b".repeat(32));await owner.issueRecoveryCode(db,"c".repeat(32));
  expect((await new Browser().post("/recover/options",{code:"b".repeat(32)})).status).toBe(403);
  const a=new Browser(),b=new Browser(),ka=await SoftKey.make(),kb=await SoftKey.make();const oa=await a.options("/recover/options",{code:"c".repeat(32)}),ob=await b.options("/recover/options",{code:"c".repeat(32)});
  const responses=await Promise.all([a.post("/recover/verify",await ka.create(oa,origin)),b.post("/recover/verify",await kb.create(ob,origin))]);expect(responses.map(r=>r.status).sort()).toEqual([200,403]);
  expect(await db.prepare("SELECT count(*) n FROM passkeys").first("n")).toBe(1);expect(await db.prepare("SELECT count(*) n FROM sessions").first("n")).toBe(1);
  expect((await a.at("/setup")).status).toBe(303);
  await owner.issueRecoveryCode(db,"d".repeat(32),-1);const expired=await new Browser().post("/recover/options",{code:"d".repeat(32)});expect((await expired.json() as any).error).toBe("code_expired");
 });
 it("exposes only the no-store release floor and keeps the legacy reader boundary (19,30)",async()=>{
  await fixture();await reader();const response=await new Browser().at("/.well-known/porchsite-release");const state=await response.json() as any;
  expect(Object.keys(state).sort()).toEqual(["private_floor","release"]);expect(state.private_floor).toBe("unknown");expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await db.prepare("SELECT count(*) n FROM sessions").first("n")).toBe(1);expect(await db.prepare("SELECT count(*) n FROM reader_sessions").first("n")).toBe(1);
  expect((await site.liveView(db)).site.private).toBe(true);
 });
});

// Pause after verification and before the atomic issuance transaction (22b).
it.each(["owner-login","reader-login","add","invite"])("fences a controlled %s interleaving",async kind=>{
 const f=await fixture();let browser:Browser, response:any, complete:(db:D1Database,req:Request,response:any)=>Promise<string>, readerId="";
 if(kind==="owner-login") {browser=new Browser();response=await f.key.get(await browser.options("/login/options"),origin);complete=owner.loginVerify;}
 else if(kind==="reader-login") {const r=await reader();readerId=r.invite.id;browser=r.browser;response=await r.key.get(await browser.options("/login/options"),origin);complete=owner.loginVerify;}
 else if(kind==="add") {browser=new Browser();const key=await SoftKey.make(),link=await owner.createPasskeyLink(db);response=await key.create(await browser.options(`/passkey/${link.token}/options`),origin);complete=owner.addVerify;}
 else {browser=new Browser();const key=await SoftKey.make(),invite=await owner.createReaderInvite(db,"Pending");readerId=invite.id;response=await key.create(await browser.options(`/invite/${invite.token}/options`),origin);complete=owner.inviteVerify;}
 let ready!:()=>void, release!:()=>void;const reached=new Promise<void>(r=>ready=r), go=new Promise<void>(r=>release=r);
 const parked=new Proxy(db,{get(target,key){if(key==="batch")return async(statements:D1PreparedStatement[])=>{ready();await go;return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
 const req=new Request(origin+"/verify",{method:"POST",headers:{Cookie:[...browser.jar].map(([k,v])=>`${k}=${v}`).join("; ")}});
 const pending=complete(parked,req,response);await reached;
 if(readerId) await owner.revokeReader(db,readerId);
 else {const recovery=new Browser(),key=await SoftKey.make();await owner.issueRecoveryCode(db,"r".repeat(32));const options=await recovery.options("/recover/options",{code:"r".repeat(32)});expect((await recovery.post("/recover/verify",await key.create(options,origin))).status).toBe(200);}
 const sessions=await db.prepare("SELECT (SELECT count(*) FROM sessions)+(SELECT count(*) FROM reader_sessions) n").first("n");
 const keys=await db.prepare("SELECT (SELECT count(*) FROM passkeys)+(SELECT count(*) FROM reader_passkeys) n").first("n");
 release();await expect(pending).rejects.toMatchObject({code:"not_verified"});
 expect(await db.prepare("SELECT (SELECT count(*) FROM sessions)+(SELECT count(*) FROM reader_sessions) n").first("n")).toBe(sessions);
 expect(await db.prepare("SELECT (SELECT count(*) FROM passkeys)+(SELECT count(*) FROM reader_passkeys) n").first("n")).toBe(keys);
});

it("does not let the prior runtime's blanket field approval approve unseen private drafts",async()=>{
 const f=await fixture(false);await content.updateItem(db,who,"site",f.item.version,{private:true},undefined);
 // The previous bundle's publish and fieldsApproval SQL, unchanged.
 await db.prepare("UPDATE live SET version=(SELECT version FROM items WHERE id='site'),data=(SELECT data FROM items WHERE id='site') WHERE item_id='site'").run();
 await db.prepare("UPDATE site_fields SET approved=1 WHERE version=(SELECT version FROM live WHERE item_id='site')").run();
 expect(await livePrivate(db)).toBe(false);expect((await site.liveView(db)).site.private).toBe(false);
});

it("keeps malformed cookies blank and canonical-host redirects private",async()=>{
 await fixture();await blank(await handle(new Request(origin+"/",{headers:{Cookie:"__Host-sk_owner=%; __Host-sk_reader=%"}}),e));
 const response=await worker.fetch(new Request("https://www.site.example/guide/published-guide/"),e,{waitUntil(){},passThroughOnException(){}} as any);
 expect(response.status).toBe(301);expect(response.headers.get("Location")).toBe(origin+"/guide/published-guide/");expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

it("rolls back every recovery mutation on an insertion failure",async()=>{
 const f=await fixture();await reader();const recovery=new Browser(),key=await SoftKey.make();await owner.issueRecoveryCode(db,"z".repeat(32));const options=await recovery.options("/recover/options",{code:"z".repeat(32)});
 const req=new Request(origin+"/recover/verify",{method:"POST",headers:{Cookie:[...recovery.jar].map(([k,v])=>`${k}=${v}`).join("; ")}});
 const broken=new Proxy(db,{get(target,key){if(key==="batch")return (statements:D1PreparedStatement[])=>target.batch([...statements.slice(0,3),target.prepare("INSERT INTO auth_state (id) VALUES (1)"),...statements.slice(3)]);const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
 await expect(owner.recoverVerify(broken,req,await key.create(options,origin))).rejects.toThrow();
 expect(await owner.ownerEpoch(db)).toBe(0);
 for(const table of ["passkeys","sessions","reader_passkeys","reader_sessions","recovery_codes"])expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first("n"),table).toBe(1);
 expect((await f.browser.at("/")).status).toBe(200);
 expect((await new Browser().post("/recover/options",{code:"z".repeat(32)})).status).toBe(200);
});

it("does not accept a reader cookie as MCP authorization",async()=>{
 await fixture();const r=await reader();
 const req=new Request(origin+"/mcp",{method:"POST",headers:{"Content-Type":"application/json",Cookie:[...r.browser.jar].map(([k,v])=>`${k}=${v}`).join("; ")},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"site_state",arguments:{}}})});
 const response=await worker.fetch(req,e,{waitUntil(){},passThroughOnException(){}} as any);expect(response.status).toBe(401);expect(await response.text()).not.toContain("Hidden handbook");
});

it("does not issue fresh access capabilities from an owner request invalidated by recovery",async()=>{
 const f=await fixture();const req=new Request(origin+"/review/passkeys",{headers:{Cookie:[...f.browser.jar].map(([k,v])=>`${k}=${v}`).join("; ")}});expect(await owner.signedIn(db,req)).toBe(true);
 const browser=new Browser(),key=await SoftKey.make();await owner.issueRecoveryCode(db,"c".repeat(32));const options=await browser.options("/recover/options",{code:"c".repeat(32)});expect((await browser.post("/recover/verify",await key.create(options,origin))).status).toBe(200);
 await expect(owner.createPasskeyLink(db,req)).rejects.toMatchObject({code:"not_verified"});await expect(owner.createReaderInvite(db,"Reader",req)).rejects.toMatchObject({code:"not_verified"});
 for(const table of ["passkey_links","reader_invites","readers"])expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first("n")).toBe(0);
});

it.each(["invite","recover","passkey"])("gates private entries in a %s stream",async stream=>{
 const f=await fixture();await content.updateItem(db,who,"site",f.item.version,{streams:[...(f.item.data.streams as Record<string,unknown>[]),{id:stream,title:"Private material",dated_addresses:false}]});
 const entry=await content.createItem(db,who,"entry",{stream,slug:"secret",title:"Confidential task",date:"2026-10-16",body:"PRIVATE-ENTRY-SENTINEL"},undefined);
 await publish(["site",entry.id]);const visitor=new Browser();await blank(await visitor.at(`/${stream}/secret/`));const head=await visitor.at(`/${stream}/secret/`,{method:"HEAD"});expect(head.status).toBe(404);expect(await head.text()).toBe("");
});

it.each(["cancel-invite","replace-recovery"])("refuses %s committed just before the D1 issuance batch",async operation=>{
 await fixture();const browser=new Browser(),key=await SoftKey.make();let path:string,options:any,complete:any,readerId="";
 if(operation === "cancel-invite") {const invite=await owner.createReaderInvite(db,"Pending");readerId=invite.id;path=`/invite/${invite.token}`;options=await browser.options(path+"/options");complete=owner.inviteVerify;}
 else {await owner.issueRecoveryCode(db,"a".repeat(32));path="/recover";options=await browser.options(path+"/options",{code:"a".repeat(32)});complete=owner.recoverVerify;}
 const changed=new Proxy(db,{get(target,key){if(key==="batch")return async(statements:D1PreparedStatement[])=>{if(operation === "cancel-invite")await owner.revokeInvite(db,readerId);else await owner.issueRecoveryCode(db,"b".repeat(32));return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
 const req=new Request(origin+path+"/verify",{method:"POST",headers:{Cookie:[...browser.jar].map(([k,v])=>`${k}=${v}`).join("; ")}});
 await expect(complete(changed,req,await key.create(options,origin))).rejects.toMatchObject({status:403});
 expect(await db.prepare("SELECT count(*) n FROM reader_passkeys").first("n")).toBe(0);expect(await db.prepare("SELECT count(*) n FROM reader_sessions").first("n")).toBe(0);expect(await db.prepare("SELECT count(*) n FROM passkeys").first("n")).toBe(1);
});
