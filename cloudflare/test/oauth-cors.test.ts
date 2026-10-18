import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import { oauthCors, OAUTH_CORS } from "../src/oauth-cors";
import type { Env } from "../src/env";
import fixture from "../../spec/fixtures/oauth-cors.json";
const e = env as unknown as Env, origin = "https://site.example";
const context = () => ({waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext);
function cors(response: Response) {
  expect(Object.fromEntries([...response.headers].filter(([name])=>name.startsWith("access-control-")))).toEqual(Object.fromEntries(Object.entries(fixture.headers).map(([name,value])=>[name.toLowerCase(),value])));
  expect((response.headers.get("Vary")??"").split(",").some(value=>value.trim().toLowerCase()==="origin")).toBe(false);
}
it("oauth_cors_identity: fixed map, body/status/cache preserved, only Vary Origin removed", async () => {
  expect(OAUTH_CORS).toEqual(fixture.headers);
  for(const row of fixture.vary) for(const status of [200,400]) {
    const headers = new Headers({"Content-Type":"text/plain","Cache-Control":"no-store","ETag":"unchanged","X-Other":"kept","Access-Control-Allow-Origin":"https://other.example","Access-Control-Allow-Credentials":"true","Access-Control-Allow-Private-Network":"true"});
    if(row.value!==null) headers.set("Vary",row.value);
    const body = new TextEncoder().encode("unchanged body \n ©"), response = oauthCors("/oauth/token",new Response(body,{status,headers}));
    cors(response);expect(response.status).toBe(status);expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(response.headers.get("Vary")).toBe(row.expected);
    for(const name of ["Content-Type","Cache-Control","ETag","X-Other"]) expect(response.headers.get(name)).toBe(headers.get(name));
  }
  for(const path of ["/authorize","/mcp","/review/","/","/oauth/register/","/.well-known/oauth-protected-resource/other"]) {
    const response = new Response("unchanged",{headers:{"Access-Control-Allow-Origin":"original",Vary:"Origin"}});
    expect(oauthCors(path,response)).toBe(response);
  }
});
it("oauth_cors_identity: all paths, methods, successful metadata and protocol refusals", async () => {
  for(const path of fixture.paths) for(const method of ["GET","HEAD","OPTIONS","POST"]) {
    let baseline: unknown;
    for(const caller of [null,origin,"https://other.example","null","","invalid origin","https://one.example, https://two.example"]) {
      const headers = new Headers({...(method==="POST"?{"Content-Type":"application/json"}:{})});
      if(caller!==null) headers.set("Origin",caller);
      const response = await worker.fetch(new Request(origin+path,{method,headers,...(method==="POST"?{body:"{}"}:{})}),{...e,SITE_URL:origin},context());
      cors(response);
      const snapshot={status:response.status,body:await response.text(),headers:Object.fromEntries([...response.headers].filter(([name])=>!name.startsWith("access-control-")))};
      if(baseline) expect(snapshot,path+method).toEqual(baseline);else baseline=snapshot;
      if(method==="OPTIONS") {expect(response.status).toBe(204);expect(response.headers.has("Content-Length")).toBe(false);}
      else if(path.startsWith("/.well-known/")&&(method==="GET"||method==="HEAD")) expect(response.status,path+method).toBe(path === "/.well-known/oauth-protected-resource" ? 404 : 200);
      else expect(response.status).toBeGreaterThanOrEqual(400);
    }
  }
});
it("oauth_cors_identity: preflight remains storage-free for all Origin forms", async () => {
  const noStorage = new Proxy({}, {get(){throw new Error("preflight storage lookup");}}), fetch = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("unexpected fetch"));
  try {
    for(const path of fixture.paths) for(const caller of [null,"",origin,"null","https://other.example","invalid origin"]) {
      const response = await worker.fetch(new Request(origin+path,{method:"OPTIONS",headers:{Authorization:"Bearer prk_invalid",...(caller===null?{}:{Origin:caller})}}),{...e,DB:noStorage,OAUTH_KV:noStorage} as unknown as Env,context());
      cors(response);expect(response.status).toBe(204);expect(await response.text()).toBe("");expect(response.headers.has("Content-Length")).toBe(false);
    }
    for(const path of fixture.paths) {
      const headers = new Headers({Origin:"https://one.example"});headers.append("Origin","https://two.example");
      const response = await worker.fetch(new Request(origin+path,{method:"OPTIONS",headers}),{...e,DB:noStorage,OAUTH_KV:noStorage} as unknown as Env,context());
      cors(response);expect(response.status).toBe(204);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {fetch.mockRestore();}
});

async function oauthWriter(){
 const go=async(path:string,init?:RequestInit)=>{const protocol=fixture.paths.includes(path);const headers=new Headers(init?.headers);if(protocol)headers.set("Origin","https://other.example");const response=await worker.fetch(new Request(origin+path,{...init,headers}),{...env,SITE_URL:origin} as unknown as Env,context());if(protocol)cors(response);return response;},redirect='https://app.example/callback';
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
it("oauth_cors_identity: valid registration and one-use PKCE token exchange keep authority", async () => {
  const token = await oauthWriter();
  const response = await worker.fetch(new Request(origin+"/mcp",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json",Accept:"application/json",Origin:"https://other.example"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})}),e,context());
  expect(response.status).toBe(403);
  expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
});
