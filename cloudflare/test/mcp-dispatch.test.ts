import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Env } from "../src/env";
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "../src/mcp";
import { toolTransport } from "../src/tool-transport";
const e=env as unknown as Env;
const ctx={waitUntil(){},passThroughOnException(){},props:{client:"Fixture",origin:"https://site.example"}} as unknown as ExecutionContext;
const origin="https://site.example";
const rpc=(method:string,params:unknown)=>({jsonrpc:"2.0",id:1,method,params});

// Independent copy of the previous endpoint's SDK adapter (baseline 59d13da).
const originalStreamed=createMcpHandler(createServer,{route:"/mcp"});
async function originalDispatcher(req:Request):Promise<Response> {
 const accept=req.headers.get("Accept")??"";
 if(req.method!=="POST"||accept.includes("text/event-stream"))return originalStreamed(req,e,ctx);
 const headers=new Headers(req.headers);
 headers.set("Accept","application/json, text/event-stream");
 const response=await originalStreamed(new Request(req,{headers}),e,ctx);
 if(!(response.headers.get("Content-Type")??"").includes("text/event-stream"))return response;
 const messages=(await response.text()).split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()).filter(Boolean);
 const out=new Headers(response.headers);
 out.set("Content-Type","application/json");out.delete("Content-Length");
 return new Response(messages.length===1?messages[0]:`[${messages.join(",")}]`,{status:response.status,headers:out});
}
it("matches the original dispatcher across the request-header matrix",async()=>{
 const types=[undefined,"application/json","Application/JSON","APPLICATION/JSON; CHARSET=UTF-8","application/json; charset=utf-8","application/json; x=1","application/json; x=1, text/plain","application/json; charset=utf-8, text/plain","application/json; charset=\"utf-8\"","application/json ; charset=utf-8","text/plain",""];
 const accepts=[undefined,"*/*","application/json","text/event-stream","application/json, text/event-stream","application/json,text/event-stream","text/plain","application/json;q=1","APPLICATION/JSON","image/png"];
  const bodies=[
  JSON.stringify(rpc("tools/list",{})),
  "{",
  JSON.stringify([rpc("tools/list",{})]),
  "",
  JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"}),
 ];
 for(const contentType of types)for(const accept of accepts)for(const body of bodies)for(const extraOrigin of [false,true]) {
  const headers=new Headers();
  if(contentType!==undefined)headers.set("Content-Type",contentType);
  if(accept!==undefined)headers.set("Accept",accept);
  if(extraOrigin)headers.set("Origin","https://other.example");
  const make=()=>new Request(`${origin}/mcp`,{method:"POST",headers,body:new TextEncoder().encode(body)});
  const before=await originalDispatcher(make()),after=await toolTransport(make(),e,ctx);
  const normalized=async(response:Response)=>({status:response.status,headers:Object.fromEntries([...response.headers].filter(([key])=>key!=="date").sort(([a],[b])=>a.localeCompare(b))),body:await response.text()});
  expect(await normalized(after),JSON.stringify({contentType,accept,body,extraOrigin})).toEqual(await normalized(before));
 }
},30000);
