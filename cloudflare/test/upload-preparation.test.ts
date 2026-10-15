import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { imageAdd } from "../src/image-add";
import * as media from "../src/media";
import type { Env } from "../src/env";
import { observeUploadPhases } from "../src/upload-diagnostic";

const db=(env as unknown as Env).DB;
const bytes=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,255]);
const png=btoa(String.fromCharCode(...bytes));
// The original preflight is the refusal oracle, including batch priority.
function original(values:string[]) {
  const files=values.map(value=>{
    const raw=value.replace(/^data:[^,]*,/,"").replace(/\s/g,"").replace(/-/g,"+").replace(/_/g,"/");
    const padding=raw.endsWith("==")?2:raw.endsWith("=")?1:0,count=raw.length-padding;
    if(/[^A-Za-z0-9+/]/.test(raw.slice(0,count))||count%4===1||(padding&&raw.length%4!==0))throw "invalid";
    return {raw,size:Math.floor(count*3/4)};
  });
  if(files.some(f=>f.size>media.MAX_BYTES)||files.reduce((sum,f)=>sum+f.size,0)>media.MAX_BYTES)throw "too_large";
  return files.map(f=>{
    const b=Uint8Array.fromBase64(f.raw);
    if(!media.sniff(b))throw "not_an_image";
    return b;
  });
}
it("matches prior encodings, invalid forms and batch refusal priority",async()=>{
 const forms=[png,png.replace(/=+$/,""),png.replace(/\+/g,"-").replace(/\//g,"_"),`data:image/gif;base64,${png}`,`data:\nimage/png,${png}`,png.slice(0,8)+" \r\n\t"+png.slice(8),png.slice(0,8)+"\u00a0\u2028"+png.slice(8),"", "A","AA=","AAA==","AAAA=","====","AA===","AA==x","not base64!!",btoa("not an image")];
 const batches=[...forms.map(s=>[s]),[btoa("not an image"),"not base64!!"],[png,"not base64!!"],["not base64!!",btoa("not an image")]];
 for(const images of batches) {
  let expected:Uint8Array[]|undefined,error:unknown;
  try{expected=original(images);}catch(e){error=e;}
  if(error){await expect(imageAdd(db,"assistant:test",undefined,images),JSON.stringify(images)).rejects.toMatchObject({code:error});continue;}
  const result=await imageAdd(db,"assistant:test",undefined,images);
  for(const [i,item] of result.images!.entries()) {
   const served=await media.serve(db,item.image.slice(7),false);
   expect(new Uint8Array(await served!.arrayBuffer())).toEqual(expected![i]);
  }
 }
});
it("keeps local phase reports free of image data and off the response",async()=>{
 const events:{phase:string,event:string,at:number}[]=[];
 observeUploadPhases((phase,event,at)=>events.push({phase,event,at}));
 try {
  const result=await imageAdd(db,"assistant:test",btoa(String.fromCharCode(...bytes,0)));
  expect(Object.keys(result)).toEqual(["image","width","height","next"]);
  expect([...new Set(events.map(e=>e.phase))]).toEqual(["preflight","decode","sniff","hash","hex","d1"]);
  for(const phase of new Set(events.map(e=>e.phase)))expect(events.filter(e=>e.phase===phase).map(e=>e.event)).toEqual(["start","end"]);
  expect(events.every(e=>Number.isFinite(e.at))).toBe(true);
 }finally{observeUploadPhases();}
});

it("accepts whitespace at the exact decoded cap without changing stored bytes",async()=>{
 const large=new Uint8Array(media.MAX_BYTES);
 large.set(bytes);
 const encoded=large.toBase64();
 const result=await imageAdd(db,"assistant:test",encoded.slice(0,8)+"\u00a0\n"+encoded.slice(8));
 if(!("image" in result))throw new Error("single-file response expected");
 const served=await media.serve(db,result.image.slice(7),false);
 const actual=await served!.arrayBuffer();
 expect(actual.byteLength).toBe(media.MAX_BYTES);
 expect(new Uint8Array(await crypto.subtle.digest("SHA-256",actual))).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256",large)));
});
