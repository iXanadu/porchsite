import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import { mcpBearer } from "../src/mcp-auth";
import * as transport from "../src/tool-transport";
import * as keys from "../src/keys";
import * as readers from "../src/read-keys";
import type { Env } from "../src/env";
import preflight from "../../spec/fixtures/mcp-preflight.json";
import { RELEASE } from "../src/home";
import rows from "../../spec/fixtures/mcp-auth-refusals.json";
const e = env as unknown as Env, origin = "https://site.example";
const context = () => ({waitUntil() {}, passThroughOnException() {}, props:{}} as unknown as ExecutionContext);
const body = JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"});
function request(authorization: string | null, method = "POST", site = origin) {
  const req = new Request(site+"/mcp", {method, headers:{"Content-Type":"application/json",Accept:"application/json"}, ...(method === "POST" ? {body} : {})});
  // Headers trims HTTP whitespace; raw ingress classification must also be exact.
  const get = req.headers.get.bind(req.headers);
  vi.spyOn(req.headers,"get").mockImplementation(name => name.toLowerCase() === "authorization" ? authorization : get(name));
  return req;
}
function refusal(response: Response, invalid: boolean, site = origin) {
  expect(response.status).toBe(401);
  expect(response.headers.get("WWW-Authenticate")).toBe(`Bearer realm="OAuth", resource_metadata="${site}/.well-known/oauth-protected-resource/mcp"${invalid ? ', error="invalid_token"' : ''}, scope="site:draft"`);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store, no-transform");
  expect(response.headers.get("Access-Control-Expose-Headers")!.toLowerCase().split(/,\s*/)).toContain("www-authenticate");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  for(const name of ["ETag","Last-Modified","Age","Location"]) expect(response.headers.has(name),name).toBe(false);
}
it("mcp_auth_refusal_headers: shared raw header matrix, both origins, no tool or fetch", async () => {
  const dispatch = vi.spyOn(transport,"toolTransport"), fetch = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("unexpected metadata fetch"));
  const before = await e.DB.prepare("SELECT COUNT(*) AS n FROM items").first();
  try {
    for (const site of [origin,"https://canonical.example:8443"]) for (const row of rows) {
      expect(!!mcpBearer(row.authorization),row.name).toBe(row.invalid);
      const response = await worker.fetch(request(row.authorization),{...e,SITE_URL:site === origin ? undefined : site},context());
      refusal(response,row.invalid,site);
      if(row.invalid) expect(await response.json()).toMatchObject({error:"invalid_token"});
      else expect(await response.text()).toBe("");
    }
    expect(dispatch).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM items").first()).toEqual(before);
  } finally {dispatch.mockRestore();fetch.mockRestore();}
});
it("mcp_auth_refusal_headers: live writer/read-key authority, expired and revoked", async () => {
  for(const [api,table] of [[keys,"assistant_keys"],[readers,"agent_read_keys"]] as const) {
    const made = await api.create(e.DB,"Header test");
    const good = await worker.fetch(request("Bearer "+made.token),e,context());
    expect(good.status).toBe(200);expect(good.headers.has("WWW-Authenticate")).toBe(false);
    const catalog = await good.json() as any;
    if(table === "agent_read_keys") expect(catalog.result.tools.length).toBe(5);
    else expect(catalog.result.tools.length).toBeGreaterThan(10);
    await e.DB.prepare(`UPDATE ${table} SET expires_at='2000-01-01' WHERE id=?`).bind(made.id).run();
    refusal(await worker.fetch(request("Bearer "+made.token),e,context()),true);
    await e.DB.prepare(`UPDATE ${table} SET expires_at='2099-01-01',revoked_at='2026-10-18' WHERE id=?`).bind(made.id).run();
    refusal(await worker.fetch(request("Bearer "+made.token),e,context()),true);
  }
});
it("mcp_auth_refusal_headers: Origin and preflight precede auth", async () => {
  for(const method of ["POST","OPTIONS"]) {
    const req = request("Bearer prk_invalid",method);req.headers.set("Origin","https://other.example");
    const denied = await worker.fetch(req,e,context());expect(denied.status).toBe(403);expect(denied.headers.has("WWW-Authenticate")).toBe(false);
  }
  for(const auth of [null,"Bearer prk_invalid"]) {
    const response = await worker.fetch(request(auth,"OPTIONS"),e,context());expect(response.status).toBe(204);expect(response.headers.has("WWW-Authenticate")).toBe(false);
  }
});

async function oauthWriter(){
 const go=(path:string,init?:RequestInit)=>worker.fetch(new Request(origin+path,init),{...env,SITE_URL:origin} as unknown as Env,context()),redirect='https://app.example/callback';
 const reg=await go('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Inspection app',redirect_uris:[redirect],token_endpoint_auth_method:'none'})});
 const {client_id}=await reg.json() as any,b64=(a:Uint8Array)=>btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const verifier=b64(crypto.getRandomValues(new Uint8Array(32))),challenge=b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))),session='preview-owner-test';
 await e.DB.prepare("INSERT OR IGNORE INTO owner(id,name,user_handle,created_at) VALUES(1,'Owner','AA','2026-10-18')").run();
 await e.DB.prepare("INSERT OR IGNORE INTO sessions(token_hash,created_at,expires_at) VALUES(?,'2026-10-18','2099-01-01')").bind(b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(session))))).run();
 const query=new URLSearchParams({response_type:'code',client_id,redirect_uri:redirect,state:'preview',scope:'site:draft',resource:origin+'/mcp',code_challenge:challenge,code_challenge_method:'S256'}),owner='__Host-sk_owner='+session;
 const page=await go('/authorize?'+query,{headers:{Cookie:owner}}),html=await page.text(),handle=/name="handle" value="([^"]+)"/.exec(html)![1],cookie=(page.headers.get('Set-Cookie')??'').split(';')[0];
 const done=await go('/authorize',{method:'POST',headers:{Cookie:owner+'; '+cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,label:'Inspection app',decision:'approve'})});
 const code=new URL(done.headers.get('Location')!).searchParams.get('code')!;
 const token=await go('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirect,client_id,code_verifier:verifier,resource:origin+'/mcp'})});
 expect(token.status).toBe(200);return (await token.json() as any).access_token as string;
}
it("mcp_auth_refusal_headers: actual OAuth valid/expired/revoked", async () => {
  const token = await oauthWriter();
  const good = await worker.fetch(request("Bearer "+token),e,context());expect(good.status).toBe(200);
  const names = await e.OAUTH_KV.list({prefix:"token:owner:"});
  const name = names.keys.find(row => row.name.startsWith("token:owner:"+token.split(":")[1]+":"))!.name;
  const stored = await e.OAUTH_KV.get(name,"json") as any;
  await e.OAUTH_KV.put(name,JSON.stringify({...stored,expiresAt:1}));
  refusal(await worker.fetch(request("Bearer "+token),e,context()),true);
  await e.OAUTH_KV.delete(name);
  refusal(await worker.fetch(request("Bearer "+token),e,context()),true);
});

it("mcp_auth_preflight_identity: no credential oracle or storage access", async () => {
  const credentials: (string|null)[] = [null,"Bearer psk_invalid","Bearer prk_invalid","Bearer owner:missing:token","Bearer one two"];
  for (const [api,table] of [[keys,"assistant_keys"],[readers,"agent_read_keys"]] as const) {
    for (const state of ["valid","expired","revoked"]) {
      const made = await api.create(e.DB,"Preflight");
      if(state === "expired") await e.DB.prepare(`UPDATE ${table} SET expires_at='2000-01-01' WHERE id=?`).bind(made.id).run();
      if(state === "revoked") await api.revoke(e.DB,made.id);
      credentials.push("Bearer "+made.token);
    }
  }
  for(const state of ["valid","expired","revoked"]) {
    const token = await oauthWriter(), names = await e.OAUTH_KV.list({prefix:"token:owner:"+token.split(":")[1]+":"});
    const name = names.keys[0].name;
    if(state === "expired") {const row = await e.OAUTH_KV.get(name,"json") as any;await e.OAUTH_KV.put(name,JSON.stringify({...row,expiresAt:1}));}
    if(state === "revoked") await e.OAUTH_KV.delete(name);
    credentials.push("Bearer "+token);
  }
  const noStorage = new Proxy({}, {get(){throw new Error("preflight touched storage");}});
  for(const auth of credentials) {
    const response = await worker.fetch(request(auth,"OPTIONS"),{...e,DB:noStorage,OAUTH_KV:noStorage} as Env,context());
    expect(response.status).toBe(preflight.status);
    expect(await response.text()).toBe(preflight.body);
    expect(Object.fromEntries(response.headers)).toEqual({...preflight.headers,"x-porchsite-release":RELEASE});
  }
});
