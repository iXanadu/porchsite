// SV-PV2 acceptance, paired with server/tests/app/test_media_http.py.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import cases from "../../spec/media-http-cases.json";
import type { Env } from "../src/env";
import * as content from "../src/content";
import * as approvals from "../src/approvals";
import * as media from "../src/media";
import { SIGN_IN as BLANK } from "../src/privacy";
import { handle } from "../src/routes";

const e = env as unknown as Env, db = e.DB, origin = "https://site.example", who = "assistant:test";
const bytes = new Uint8Array([255,216,255,224,0,128,254,7]);
const at = (path: string, method = "GET", headers: Record<string,string> = {}) => handle(new Request(origin + path, {method, headers}), e);
async function publish(ids: string[]) {
  const a = await approvals.request(db, who, ids, "");
  await approvals.decide(db, a.id, Object.fromEntries(ids.map(id => [id, {decision:"approve" as const}])), "");
}
async function fixture() {
  const path = await media.store(db, bytes, "image/jpeg", "fixture");
  const item = await content.createItem(db, who, "site", {title:"Media fixture"}, undefined);
  const card = await content.createItem(db, who, "card", {name:"Picture", description:"Picture", image:path, image_alt:"Fixture"}, undefined);
  await publish([item.id, card.id]);
  return {path, item, card};
}
async function hash(token: string) {
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token))))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
async function sessions() {
  await db.prepare("INSERT INTO sessions (token_hash,created_at,expires_at) VALUES (?,?,?)").bind(await hash("owner-token"), "2026-10-10", "2099-01-01").run();
  await db.prepare("INSERT INTO readers (id,name,created_at) VALUES ('reader','Reader','2026-10-10')").run();
  await db.prepare("INSERT INTO reader_passkeys (id,reader_id,public_key,created_at) VALUES ('credential','reader',?,'2026-10-10')").bind(new Uint8Array([1])).run();
  await db.prepare("INSERT INTO reader_sessions (token_hash,reader_id,credential_id,epoch,created_at,expires_at) VALUES (?,'reader','credential',0,'2026-10-10','2099-01-01')").bind(await hash("reader-token")).run();
  return ["__Host-sk_owner=owner-token", "__Host-sk_reader=reader-token"];
}
beforeEach(async () => {
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
  for (const {name} of rows.results) if (/^[a-z][a-z_]*$/.test(name) && !name.startsWith("sqlite_") && !name.startsWith("d1_")) await db.prepare(`DELETE FROM ${name}`).run();
  await db.prepare("INSERT INTO auth_state (id) VALUES (1)").run();
});
describe("media revalidation", () => {
  it("hashes canonical URL, exact type, empty signal and binary stored bytes; HEAD matches GET", async () => {
    const {path} = await fixture();
    const prefix = new TextEncoder().encode(origin + path + "\0image/jpeg\0\0");
    const input = new Uint8Array(prefix.length + bytes.length); input.set(prefix); input.set(bytes,prefix.length);
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256",input))].map(x=>x.toString(16).padStart(2,"0")).join("");
    const r = await at(path + "?ignored=1");
    expect(r.headers.get("ETag")).toBe(`W/"sha256-${hex}"`);
    expect(r.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
    const head = await at(path,"HEAD"); expect(head.status).toBe(200);
    expect([...head.headers]).toEqual([...r.headers]); expect(await head.text()).toBe("");
  });
  it("implements weak, strong, wildcard, list and malformed conditions for GET and HEAD", async () => {
    const {path} = await fixture(), tag = (await at(path)).headers.get("ETag")!;
    for (const c of cases) for (const method of ["GET","HEAD"]) {
      const headers: Record<string,string> = {"If-Modified-Since":"Wed, 01 Jan 2099 00:00:00 GMT"};
      if(c.value !== null) headers["If-None-Match"] = c.value.replaceAll("$tag",tag).replaceAll("$strong",tag.slice(2));
      const r = await at(path,method,headers); expect(r.status,c.name+method).toBe(c.status);
      expect(r.headers.get("ETag")).toBe(tag); expect(r.headers.get("Cache-Control")).toBe("no-cache, no-transform");
      if(c.status===304 || method==="HEAD") {expect(await r.text()).toBe("");if(c.status===304) expect(Number(r.headers.get("Content-Length")??0)).toBe(0);}
      else expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
    }
  });
  it("isolates owner, reader, invalid session cookies and Authorization from anonymous validators", async () => {
    const {path} = await fixture(), cookies = await sessions(), tag = (await at(path)).headers.get("ETag")!;
    for(const actor of [...cookies,"__Host-sk_owner=expired","__Host-sk_reader=expired","authorization"]) for(const method of ["GET","HEAD"]) {
      const headers: Record<string,string> = actor==="authorization" ? {Authorization:"Bearer unused"} : {Cookie:actor};
      const r = await at(path,method,{...headers,"If-None-Match":tag});expect(r.status).toBe(200);
      expect(r.headers.get("Cache-Control")).toBe("private, no-store, no-transform");expect(r.headers.has("ETag")).toBe(false);expect(r.headers.has("Last-Modified")).toBe(false);
    }
    expect((await at(path,"GET",{Cookie:"other=__Host-sk_reader=not-a-cookie","If-None-Match":tag})).status).toBe(304);
  });
  it("checks last published reference before warm tags and wildcard; drafts and history do not count", async () => {
    const {path,card} = await fixture(), tag = (await at(path)).headers.get("ETag")!;
    const other = await content.createItem(db,who,"card",{name:"Other",description:"d",image:path,image_alt:"Fixture"},undefined);await publish([other.id]);
    await content.removeItem(db,who,card.id,card.version);await publish([card.id]);
    expect((await at(path,"GET",{"If-None-Match":tag})).status).toBe(304);
    await content.createItem(db,who,"card",{name:"Pending",description:"d",image:path,image_alt:"Fixture"},undefined);
    await content.createItem(db,who,"entry",{title:"Draft",date:"2026-10-17",status:"draft",cover:path,cover_alt:"Fixture"},undefined);
    await content.removeItem(db,who,other.id,other.version);await publish([other.id]);
    const read = vi.spyOn(media,"serve");
    try {for(const method of ["GET","HEAD"]) for(const condition of [tag,"*"]) {const r = await at(path,method,{"If-None-Match":condition});expect(r.status).toBe(404);expect(r.headers.get("Cache-Control")).toBe("no-store");expect(r.headers.has("ETag")).toBe(false);}expect(read).not.toHaveBeenCalled();} finally {read.mockRestore();}
  });
  it("private-on gates warm validators before byte lookup, while owner and reader stay no-store", async () => {
    const {path,item} = await fixture(), cookies = await sessions(), tag = (await at(path)).headers.get("ETag")!;
    await content.updateItem(db,who,item.id,item.version,{private:true});await publish([item.id]);
    const read = vi.spyOn(media,"serve");
    try {for(const method of ["GET","HEAD"]) for(const condition of [tag,"*"]) {const r = await at(path,method,{"If-None-Match":condition});expect(r.status).toBe(404);expect(await r.text()).toBe(method==="HEAD"?"":BLANK);expect(r.headers.get("Cache-Control")).toBe("private, no-store, no-transform");expect(r.headers.has("ETag")).toBe(false);}expect(read).not.toHaveBeenCalled();} finally {read.mockRestore();}
    for(const cookie of cookies) for(const method of ["GET","HEAD"]) {const r=await at(path,method,{Cookie:cookie,"If-None-Match":tag});expect(r.status).toBe(200);expect(r.headers.get("Cache-Control")).toBe("private, no-store, no-transform");expect(r.headers.has("ETag")).toBe(false);}
  });
  it("keeps unpublished pictures owner-only and media misses no-store", async () => {
    await fixture();const cookies = await sessions();const path=await media.store(db,new Uint8Array([255,216,255,224,9]),"image/jpeg","fixture");
    for(const cookie of ["",cookies[1]]) {const r=await at(path,"GET",{Cookie:cookie,"If-None-Match":"*"});expect(r.status).toBe(404);expect(r.headers.get("Cache-Control")).toContain("no-store");expect(r.headers.has("ETag")).toBe(false);}
    const mine=await at(path,"GET",{Cookie:cookies[0],"If-None-Match":"*"});expect(mine.status).toBe(200);expect(mine.headers.get("Cache-Control")).toBe("private, no-store, no-transform");expect(mine.headers.has("ETag")).toBe(false);
    const missing=await at("/media/00000000000000000000000000000000.jpg","HEAD",{"If-None-Match":"*"});expect(missing.status).toBe(404);expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });
  it("revalidates generated share pictures against their current live entry", async () => {
    await fixture();const path=await media.store(db,new Uint8Array([255,216,255,224,10]),"image/jpeg","fixture");
    const entry=await content.createItem(db,who,"entry",{title:"Shared",date:"2026-10-17"},undefined);await publish([entry.id]);
    await db.prepare("INSERT INTO share_cards (item_id,version,name,created_at) VALUES (?,?,?,'2026-10-17')").bind(entry.id,entry.version,path.slice(7)).run();
    const tag=(await at(path)).headers.get("ETag")!;expect(tag).toMatch(/^W\/"sha256-[a-f0-9]{64}"$/);expect((await at(path,"HEAD",{"If-None-Match":tag})).status).toBe(304);
    await content.removeItem(db,who,entry.id,entry.version);await publish([entry.id]);expect((await at(path,"GET",{"If-None-Match":tag})).status).toBe(404);
  });
  it("a stalled authorized byte read cannot refill a response cache after removal", async () => {
    const {path,card} = await fixture();
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => {ready=resolve;});
    const resume = new Promise<void>(resolve => {release=resolve;});
    const original = media.serve;
    const read = vi.spyOn(media,"serve").mockImplementationOnce(async (...args) => {
      const response = await original(...args); ready(); await resume; return response;
    });
    try {
      const pending = at(path); await entered;
      await content.removeItem(db,who,card.id,card.version); await publish([card.id]);
      expect((await at(path,"GET",{"If-None-Match":"*"})).status).toBe(404);
      release(); const earlier = await pending;
      expect(earlier.status).toBe(200); // Existing authorized in-flight response limitation.
      const tag = earlier.headers.get("ETag")!;
      expect((await at(path,"GET",{"If-None-Match":tag})).status).toBe(404);
    } finally {release();read.mockRestore();}
  });

});
