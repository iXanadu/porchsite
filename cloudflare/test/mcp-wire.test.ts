// Golden endpoint transcript recorded from the previously shipped dispatcher.
// Compare response bytes and every header except Date; header order is immaterial.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { observeMcpDispatch } from "../src/mcp-dispatch-diagnostic";

const e = env as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
afterEach(() => observeMcpDispatch());
const origin = "https://site.example";
const token = "psk_wire_fixture";
const rpc = (method: string, params?: unknown, id: unknown = 1) => ({jsonrpc:"2.0",id,method,...(params===undefined?{}:{params})});
const init = (version: string) => rpc("initialize", {protocolVersion:version,capabilities:{},clientInfo:{name:"fixture",version:"1"}});
const call = (name: string, args: unknown = {}) => rpc("tools/call", {name,arguments:args});
interface Case { name: string; method?: string; body?: unknown; raw?: string; headers?: Record<string,string>; auth?: string | null }
const modern = {"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"fixture",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}};
const cases: Case[] = [
 {name:"modern discovery",body:rpc("server/discover",{_meta:modern}),headers:{"Mcp-Protocol-Version":"2026-07-28","Mcp-Method":"server/discover"}},
 {name:"modern tools list",body:rpc("tools/list",{_meta:modern}),headers:{"Mcp-Protocol-Version":"2026-07-28","Mcp-Method":"tools/list"}},
 {name:"modern tool call",body:rpc("tools/call",{name:"approval_status",arguments:{},_meta:modern}),headers:{"Mcp-Protocol-Version":"2026-07-28","Mcp-Method":"tools/call","Mcp-Name":"approval_status"}},
 {name:"modern unknown version",body:rpc("server/discover",{_meta:{...modern,"io.modelcontextprotocol/protocolVersion":"2099-01-01"}})},
 {name:"modern malformed envelope",body:rpc("tools/list",{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}})},
 ...["2024-11-05","2025-03-26","2025-06-18","2025-11-25","2026-07-28","1900-01-01", ""].map(v=>({name:`initialize ${v}`,body:init(v)})),
 {name:"initialize missing fields",body:rpc("initialize",{})},
 {name:"initialized notification",body:{jsonrpc:"2.0",method:"notifications/initialized"}},
 {name:"unknown notification",body:{jsonrpc:"2.0",method:"notifications/fixture",params:{}}},
 {name:"cancellation notification",body:{jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:1,reason:"fixture"}}},
 {name:"tools list",body:rpc("tools/list",{})},
 {name:"tools list no params",body:rpc("tools/list")},
 {name:"success",body:call("approval_status")},
 {name:"tool error",body:call("item_update",{id:"missing",version:1,data:{}})},
 {name:"validation missing",body:call("item_update")},
 {name:"validation types",body:call("item_update",{id:3,version:0,data:null})},
 {name:"validation array",body:call("approval_status",[])},
 {name:"validation null",body:call("approval_status",null)},
 {name:"unknown tool",body:call("missing")},
 {name:"missing tool name",body:rpc("tools/call",{})},
 {name:"unknown method",body:rpc("missing",{})},
 {name:"ping",body:rpc("ping")},
 {name:"malformed",raw:"{"},
 {name:"empty body",raw:""},
 {name:"batch",body:[rpc("tools/list"),call("approval_status")]},
 {name:"empty batch",body:[]},
 {name:"null",body:null},
 {name:"scalar",body:1},
 {name:"missing jsonrpc",body:{id:1,method:"tools/list"}},
 {name:"wrong jsonrpc",body:{jsonrpc:"1.0",id:1,method:"tools/list"}},
 {name:"null id",body:rpc("tools/list",{},null)},
 {name:"string id",body:rpc("tools/list",{},"fixture")},
 {name:"object id",body:rpc("tools/list",{},{})},
 {name:"GET",method:"GET"},
 {name:"DELETE",method:"DELETE"},
 {name:"OPTIONS",method:"OPTIONS"},
 ...["application/json","text/event-stream","application/json, text/event-stream","*/*","text/plain", ""].map(accept=>({name:`accept ${accept}`,headers:{Accept:accept},body:call("approval_status")})),
 ...["text/plain","application/json; charset=utf-8","application/json; x=1, text/plain","application/json; x=1","application/json; charset=utf-8, text/plain","application/json; charset=\"utf-8\"","application/json; charset=\"unterminated","Application/JSON","application/json ; charset=utf-8",""].map(type=>({name:`content type ${type}`,headers:{"Content-Type":type},body:call("approval_status")})),
 {name:"session id",headers:{"Mcp-Session-Id":"fixture-session"},body:call("approval_status")},
 {name:"protocol header legacy",headers:{"Mcp-Protocol-Version":"2025-06-18"},body:call("approval_status")},
 {name:"protocol header modern",headers:{"Mcp-Protocol-Version":"2026-07-28"},body:call("approval_status")},
 {name:"protocol header unknown",headers:{"Mcp-Protocol-Version":"unknown"},body:call("approval_status")},
 {name:"foreign origin",headers:{Origin:"https://other.example"},body:call("approval_status")},
 {name:"same origin",headers:{Origin:origin},body:call("approval_status")},
 {name:"foreign host",headers:{Host:"other.example"},body:call("approval_status")},
 {name:"no auth",auth:null,body:call("approval_status")},
 {name:"bad key",auth:"Bearer psk_missing",body:call("approval_status")},
 {name:"bad OAuth",auth:"Bearer missing",body:call("approval_status")},
];

const b64 = (b:Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
async function oauthToken(at:string):Promise<string> {
 const go=(path:string,init?:RequestInit)=>worker.fetch(new Request(`${at}${path}`,init),{...e},ctx);
 const session="wire-owner-session";
 const hash=b64(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(session))));
 await e.DB.prepare("INSERT OR IGNORE INTO owner(id,name,user_handle,created_at) VALUES (1,'Owner','AA','2026-01-01')").run();
 await e.DB.prepare("INSERT OR REPLACE INTO sessions(token_hash,created_at,expires_at) VALUES (?,'2026-01-01','2099-01-01')").bind(hash).run();
 const redirect="https://app.example/callback";
 const reg=await go("/oauth/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_name:"Fixture",redirect_uris:[redirect],token_endpoint_auth_method:"none"})});
 expect(reg.status).toBe(201);
 const {client_id}=await reg.json() as {client_id:string};
 const verifier=b64(crypto.getRandomValues(new Uint8Array(32)));
 const challenge=b64(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
 const query=new URLSearchParams({response_type:"code",client_id,resource:`${at}/mcp`,redirect_uri:redirect,state:"fixture",scope:"site:draft",code_challenge:challenge,code_challenge_method:"S256"});
 const owner=`__Host-sk_owner=${session}`;
 const consent=await go(`/authorize?${query}`,{headers:{Cookie:owner}});
 expect(consent.status,at).toBe(200);
 const handle=/name="handle" value="([^"]+)"/.exec(await consent.text())![1];
 const cookie=(consent.headers.get("Set-Cookie")??"").split(";")[0];
 const approved=await go("/authorize",{method:"POST",headers:{Cookie:`${owner}; ${cookie}`,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({handle,label:"Fixture",decision:"approve"})});
 expect(approved.status).toBe(302);
 const code=new URL(approved.headers.get("Location")!).searchParams.get("code")!;
 const token=await go("/oauth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",code,resource:`${at}/mcp`,redirect_uri:redirect,client_id,code_verifier:verifier})});
 expect(token.status).toBe(200);
 return (await token.json() as {access_token:string}).access_token;
}

it("preserves the recorded MCP HTTP wire transcript", async () => {
 const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token)));
 const hash=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
 await e.DB.prepare("INSERT OR IGNORE INTO assistant_keys(id,name,key_hash,created_at,expires_at) VALUES ('key_wire','Fixture',?,'2026-01-01','2099-01-01')").bind(hash).run();
 const good=await oauthToken(origin), foreign=await oauthToken("https://other.example");
 const allCases=[...cases,
  {name:"owner OAuth fast",auth:`Bearer ${good}`,body:call("approval_status")},
  {name:"owner OAuth fallback",auth:`Bearer ${good}`,body:rpc("server/discover",{_meta:modern}),headers:{"Mcp-Protocol-Version":"2026-07-28","Mcp-Method":"server/discover"}},
  {name:"foreign site OAuth",auth:`Bearer ${foreign}`,body:call("approval_status")},
 ];
 const transcript=[];
 const paths=new Map<string,string>();
 let current="";
 observeMcpDispatch(path=>paths.set(current,path));
 for(const c of allCases) {
  current=c.name;
  const headers=new Headers({"Content-Type":"application/json",Accept:"application/json, text/event-stream",...(c.auth===null?{}:{Authorization:c.auth??`Bearer ${token}`}),...c.headers});
  if(headers.get("Content-Type")==="")headers.delete("Content-Type");
  if(headers.get("Accept")==="")headers.delete("Accept");
  const response=await worker.fetch(new Request(`${origin}/mcp`,{method:c.method??"POST",headers,...(!c.method||c.method==="POST"?{body:c.raw??JSON.stringify(c.body)}:{})}),{...e},ctx);
  transcript.push({name:c.name,status:response.status,headers:Object.fromEntries([...response.headers].filter(([k])=>k!=="date").sort(([a],[b])=>a.localeCompare(b))),body:await response.text()});
 }
 observeMcpDispatch();
 // The baseline recording has no diagnostic; the replacement must exercise both paths.
 if(paths.size) {
  for(const name of ["success","tool error","tools list","initialize 2025-06-18","owner OAuth fast"]) expect(paths.get(name),name).toBe("fast");
  for(const name of ["modern discovery","modern tools list","modern tool call","batch","malformed","validation missing","owner OAuth fallback"]) expect(paths.get(name),name).toBe("sdk");
 }
 await expect(JSON.stringify(transcript,null,2)+"\n").toMatchFileSnapshot("./fixtures/mcp-wire.json");
}, 30000);

it("keeps concurrent assistant identities and origins separate", async () => {
 const {create}=await import("../src/keys");
 const content=await import("../src/content");
 const [a,b]=await Promise.all([create(e.DB,"First"),create(e.DB,"Second")]);
 const invoke=async(at:string,key:string,message:unknown)=>{
  const r=await worker.fetch(new Request(`${at}/mcp`,{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(message)}),{...e},ctx);
  expect(r.status).toBe(200);
  const rpc=await r.json() as {result:{content:{text:string}[]}};
  return JSON.parse(rpc.result.content[0].text);
 };
 const [first,second]=await Promise.all([
  invoke("https://first.example",a.token,call("item_create",{kind:"note",data:{text:"First note",date:"2026-10-10"}})),
  invoke("https://second.example",b.token,call("item_create",{kind:"note",data:{text:"Second note",date:"2026-10-10"}})),
 ]);
 expect((await content.history(e.DB,first.id))[0].actor).toBe("assistant:First");
 expect((await content.history(e.DB,second.id))[0].actor).toBe("assistant:Second");
 const [one,two]=await Promise.all([
  invoke("https://first.example",a.token,call("photo_upload_link")),
  invoke("https://second.example",b.token,call("photo_upload_link")),
 ]);
 expect(new URL(one.url).origin).toBe("https://first.example");
 expect(new URL(two.url).origin).toBe("https://second.example");
});

it("reports each dispatch path only through local instrumentation", async () => {
 const {create}=await import("../src/keys");
 const {token}=await create(e.DB,"Diagnostic");
 const paths:string[]=[];
 observeMcpDispatch(path=>paths.push(path));
 for(const message of [rpc("tools/list",{}),rpc("missing",{})]) {
  const response=await worker.fetch(new Request(`${origin}/mcp`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(message)}),{...e},ctx);
  expect(response.status).toBe(200);
  await response.text();
  expect([...response.headers.keys()].filter(name=>/dispatch|diagnostic|fast-path/.test(name))).toEqual([]);
 }
 expect(paths).toEqual(["fast","sdk"]);
});
