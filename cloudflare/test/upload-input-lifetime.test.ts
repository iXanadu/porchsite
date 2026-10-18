import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { toolTransport } from "../src/tool-transport";
import { originalMcp } from "../src/mcp-original";
import { observeMcpDispatch } from "../src/mcp-dispatch-diagnostic";
import { imageAdd, IMAGE_INPUT_RELEASE, type OwnedImageInput } from "../src/image-add";
const e=env as unknown as Env;
const ctx={waitUntil(){},passThroughOnException(){},props:{client:"Fixture",origin:"https://site.example"}} as unknown as ExecutionContext;
const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
const rpc=(args:unknown)=>JSON.stringify({jsonrpc:"2.0",id:17,method:"tools/call",params:{name:"image_add",arguments:args}});
function request(body:string,headers:Record<string,string>={}) {
 let cancels=0;
 const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(body));c.close();},cancel(){cancels++;}});
 return {req:new Request("https://site.example/mcp",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json",...headers},body:stream}),cancels:()=>cancels};
}
const normalized=async(r:Response)=>({status:r.status,headers:Object.fromEntries([...r.headers].filter(([k])=>k!=="date").sort(([a],[b])=>a.localeCompare(b))),body:await r.text()});
it("keeps streamed image success/error and fallback bytes identical to the SDK",async()=>{
 for(const args of [{data:png},{images:[png,png]},{data:"not base64!!"},{data:png,images:[png]},{data:null},{images:[]},{images:[null]},{data:png,ignored:"value"}]){
  for(const headers of [{},{"Mcp-Protocol-Version":"2020-01-01"},{"X-Extra":"value"},{Accept:"application/json;q=1"}] as Record<string,string>[]){
   const before=request(rpc(args),headers),after=request(rpc(args),headers);
   expect(await normalized(await toolTransport(after.req,e,ctx))).toEqual(await normalized(await originalMcp(before.req,e,ctx)));
   expect(after.cancels()).toBe(before.cancels());
  }
 }
});
it("never cancels the original body before SDK fallback is selected",async()=>{
 const cases:[string,Record<string,string>][]=[["{",{}],[rpc({data:null}),{}],[rpc({images:[]}),{}],[rpc({data:png}),{"Mcp-Protocol-Version":"2020-01-01"}],[rpc({data:png}),{Accept:"application/json;q=1"}]];
 for(const [body,headers] of cases){const {req}=request(body,headers);let calls=0;const clone=req.clone.bind(req);vi.spyOn(req,"clone").mockImplementationOnce(()=>{const copy=clone();const cancel=req.body!.cancel.bind(req.body!);vi.spyOn(req.body!,"cancel").mockImplementationOnce(reason=>{calls++;return cancel(reason);});return copy;});await normalized(await toolTransport(req,e,ctx));expect(calls).toBe(0);}
});
it("cleanup rejection, synchronous failure or a pending cancel cannot change or delay the result",async()=>{
 const baseline=await normalized(await originalMcp(request(rpc({data:png})).req,e,ctx));
 for(const mode of ["reject","throw","pending"]){
  const {req}=request(rpc({data:png}));let calls=0;const clone=req.clone.bind(req);
  vi.spyOn(req,"clone").mockImplementationOnce(()=>{const copy=clone();vi.spyOn(req.body!,"cancel").mockImplementationOnce(()=>{calls++;if(mode==="reject")return Promise.reject(new Error("synthetic cancellation failure"));if(mode==="throw")throw new Error("synthetic cancellation failure");return new Promise<void>(()=>{});});return copy;});
  const paths:string[]=[];observeMcpDispatch(path=>paths.push(path));
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{const response=await Promise.race([toolTransport(req,e,ctx),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error("cleanup was awaited")),2000);})]);expect(await normalized(response)).toEqual(baseline);expect(paths).toEqual(["fast"]);expect(calls).toBe(1);}
  finally{observeMcpDispatch();if(timeout!==undefined)clearTimeout(timeout);}
 }
});
it("clears only explicitly owned encoded inputs after successful decoding and retains batch shape",async()=>{
 const input:OwnedImageInput={images:[png,png]};const release=vi.fn(()=>{delete input.data;delete input.images;delete input[IMAGE_INPUT_RELEASE];});
 input[IMAGE_INPUT_RELEASE]=release;
 const result=await imageAdd(e.DB,"assistant:test",input.data,input.images,release);
 expect(result.images).toHaveLength(2);expect(release).toHaveBeenCalledOnce();expect(input).toEqual({});
 const ordinary=[png,png];await imageAdd(e.DB,"assistant:test",undefined,ordinary);expect(ordinary).toEqual([png,png]);
 const failed=vi.fn();await expect(imageAdd(e.DB,"assistant:test","not base64!!",undefined,failed)).rejects.toMatchObject({code:"invalid"});expect(failed).not.toHaveBeenCalled();
});

// The same fixture is checked through the actual authenticated server endpoint.
import pairedCases from "../../spec/upload-input-lifetime.json";
import worker from "../src/index";
import * as keys from "../src/keys";
it("upload_input_lifetime keeps paired success, ordering and refusal behavior",async()=>{
 const {token}=await keys.create(e.DB,"Fixture");
 for(const fixture of pairedCases){
  const before=(await e.DB.prepare("SELECT name,size,width,height FROM media ORDER BY name").all()).results;
  const response=await worker.fetch(new Request("https://site.example/mcp",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json"},body:rpc(fixture.args)}),e,ctx);
  expect(response.status,fixture.name).toBe(200);
  const envelope=await response.json() as any;const result=envelope.result;const value=JSON.parse(result.content[0].text);
  if(fixture.error){expect(result.isError,fixture.name).toBe(true);expect(value.error).toBe(fixture.error);expect((await e.DB.prepare("SELECT name,size,width,height FROM media ORDER BY name").all()).results).toEqual(before);}
  else{expect(!!result.isError,fixture.name).toBe(false);expect(fixture.batch?value.images:[{image:value.image,width:value.width,height:value.height}]).toEqual(fixture.images);expect("images" in value).toBe(fixture.batch);expect(typeof value.next).toBe("string");expect(value.next).not.toBe("");}
 }
});

it("upload_input_lifetime waits for the complete body before cancellation or storage",async()=>{
 const encoded=new TextEncoder().encode(rpc({data:png}));let controller!:ReadableStreamDefaultController<Uint8Array>;let calls=0;let closed=false;
 const stream=new ReadableStream<Uint8Array>({start(c){controller=c;c.enqueue(encoded.subarray(0,encoded.length-8));}});
 const req=new Request("https://site.example/mcp",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:stream});
 const clone=req.clone.bind(req);vi.spyOn(req,"clone").mockImplementationOnce(()=>{const copy=clone();const cancel=req.body!.cancel.bind(req.body!);vi.spyOn(req.body!,"cancel").mockImplementationOnce(reason=>{calls++;return cancel(reason);});return copy;});
 const before=(await e.DB.prepare("SELECT name FROM media ORDER BY name").all()).results;
 const pending=toolTransport(req,e,ctx);
 try{
  expect(calls).toBe(0);expect((await e.DB.prepare("SELECT name FROM media ORDER BY name").all()).results).toEqual(before);
  controller.enqueue(encoded.subarray(encoded.length-8));controller.close();closed=true;
  const response=await pending;expect(response.status).toBe(200);const result=(await response.json() as any).result;expect(!!result.isError).toBe(false);expect(calls).toBe(1);
 }finally{if(!closed)controller.error(new Error("test body interrupted"));await pending.catch(()=>{});}
});
