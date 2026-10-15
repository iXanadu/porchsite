// Error transcript captured from the previous upload implementation.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import * as keys from "../src/keys";
import type { Env } from "../src/env";

it("preserves upload refusal bytes",async()=>{
 const e=env as unknown as Env;
 const {token}=await keys.create(e.DB,"Fixture");
 const ctx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
 const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
 const cases:[string,Record<string,unknown>][]=[
  ["bad base64",{data:"not base64!!"}],
  ["oversize",{data:"A".repeat((8*1024*1024+1)/3*4)}],
  ["both",{data:png,images:[png]}],
  ["neither",{}],
  ["nine files",{images:Array(9).fill(png)}],
 ];
 const answers=[];
 for(const [name,args] of cases){
  const response=await worker.fetch(new Request("https://site.example/mcp",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"image_add",arguments:args}})}),e,ctx);
  answers.push({name,status:response.status,headers:Object.fromEntries([...response.headers].filter(([key])=>key!=="date").sort(([a],[b])=>a.localeCompare(b))),body:await response.text()});
 }
 await expect(JSON.stringify(answers,null,2)+"\n").toMatchFileSnapshot("./fixtures/image-add-errors.json");
});
