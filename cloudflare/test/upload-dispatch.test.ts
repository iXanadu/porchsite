import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Env } from "../src/env";
import { originalMcp } from "../src/mcp-original";
import { toolTransport } from "../src/tool-transport";
const e=env as unknown as Env;
const ctx={waitUntil(){},passThroughOnException(){},props:{client:"Fixture",origin:"https://site.example"}} as unknown as ExecutionContext;
const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
it("matches original SDK image argument validation and response bytes",async()=>{
 const variants:unknown[]=[undefined,null,[],{},1,"",{data:png},{images:[png]},{images:[png,png]},{data:png,filename:"ignored",extra:true},{data:png,images:[png]},{data:null},{data:0},{data:{}},{data:[]},{images:null},{images:[]},{images:[null]},{images:[0]},{images:[[png]]},{images:{}},{images:Array(9).fill(png)},{data:png,images:null},{data:null,images:[png]},{data:"not base64!!"},{images:[png,"not base64!!"]}];
 for(const args of variants) {
  const make=()=>new Request("https://site.example/mcp",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"image_add",...(args===undefined?{}:{arguments:args})}})});
  const normalize=async(r:Response)=>({status:r.status,headers:Object.fromEntries([...r.headers].filter(([key])=>key!=="date").sort(([a],[b])=>a.localeCompare(b))),body:await r.text()});
  const before=await normalize(await originalMcp(make(),e,ctx));
  const after=await normalize(await toolTransport(make(),e,ctx));
  expect(after,JSON.stringify(args)).toEqual(before);
 }
});
