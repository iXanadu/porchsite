import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import cases from "../../spec/image-privacy-cases.json";
import { stripLocation } from "../src/image-privacy";
import { imageAdd } from "../src/image-add";
import * as media from "../src/media";
import type { Env } from "../src/env";
const get=(name:string)=>Uint8Array.fromBase64((cases as Record<string,string>)[name]);
// Independent container reader: compare every encoded pixel chunk and the entire
// expected allowlisted TIFF, not only the presence of a GPS tag's name.
function parts(b:Uint8Array,type:string):{name:string,data:Uint8Array}[]{
 const out=[]; const v=new DataView(b.buffer,b.byteOffset,b.length);
 if(type==="jpeg"){
  for(let p=2;p+4<=b.length;){const m=v.getUint16(p);if(m===0xffda){out.push({name:"pixels",data:b.slice(p)});break;}const n=v.getUint16(p+2);out.push({name:m===0xffe1?"EXIF":String(m),data:b.slice(p+4,p+2+n)});p+=2+n;}
 }else if(type==="png"){
  for(let p=8;p+12<=b.length;){const n=v.getUint32(p);out.push({name:String.fromCharCode(...b.slice(p+4,p+8)),data:b.slice(p+8,p+8+n)});p+=n+12;}
 }else for(let p=12;p+8<=b.length;){const n=v.getUint32(p+4,true);out.push({name:String.fromCharCode(...b.slice(p,p+4)),data:b.slice(p+8,p+8+n)});p+=8+n+n%2;}
 return out;
}
const encoded=(b:Uint8Array,t:string)=>parts(b,t).filter(p=>t==="jpeg"?p.name==="pixels":t==="png"?p.name==="IDAT":["VP8 ","VP8L"].includes(p.name)).map(p=>p.data.toHex());
const minimal="49492a0008000000010012010300010000000600000000000000";
function exif(b:Uint8Array,t:string){let d=parts(b,t).find(p=>["EXIF","eXIf"].includes(p.name))?.data;if(t==="jpeg"&&d)d=d.slice(6);return d;}
for(const type of ["jpeg","png","webp"]){
 it(`removes separate GPS IFD and preserves orientation and encoded ${type} pixels`,()=>{
  const original=get(`gps.${type}`),result=stripLocation(original,`image/${type}`);
  expect(exif(result,type)?.toHex()).toBe(minimal);
  expect(encoded(result,type)).toEqual(encoded(original,type));
  expect(media.sniff(result)).toBe(`image/${type}`);
  expect(media.size(result)).toEqual(media.size(original));
  expect(stripLocation(result,`image/${type}`)).toBe(result);
  const plain=get(`plain.${type}`);expect(stripLocation(plain,`image/${type}`)).toBe(plain);
 });
 it(`bounds hostile ${type} TIFF reads and never preserves old pointers`,()=>{
  for(const mutation of ["cycle","offset","count","truncated"]){
   const b=get(`gps.${type}`),p=parts(b,type).find(p=>["EXIF","eXIf"].includes(p.name))!;
   // Find this exact metadata payload in the original; the reader returned a copy.
   const hex=b.toHex(),index=hex.indexOf(p.data.toHex())/2+(type==="jpeg"?6:0),v=new DataView(b.buffer);
   if(mutation==="cycle")v.setUint32(index+34,8,true);
   if(mutation==="offset")v.setUint32(index+4,0xfffffff0,true);
   if(mutation==="count")v.setUint16(index+8,65535,true);
   if(mutation==="truncated")v.setUint32(index+4,p.data.length-1,true);
   const result=stripLocation(b,`image/${type}`);
   expect(encoded(result,type)).toEqual(encoded(b,type));
   if(mutation==="cycle")expect(exif(result,type)?.toHex()).toBe(minimal);
   else expect(exif(result,type)).toBeUndefined();
  }
 });
 it(`hashes sanitized ${type} bytes identically in single, batch and shared storage`,async()=>{
  const db=(env as unknown as Env).DB,b=get(`gps.${type}`),clean=stripLocation(b,`image/${type}`);
  const a=await imageAdd(db,"assistant:test",b.toBase64()),batch=await imageAdd(db,"assistant:test",undefined,[b.toBase64(),clean.toBase64()]);
  const shared=await media.store(db,b,`image/${type}`,"upload");
  const path="image" in a?a.image!:""; expect(batch.images!.map(x=>x.image)).toEqual([path,path]);expect(shared).toBe(path);
  const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",clean)).subarray(0,16).toHex();expect(path).toContain(hash);
  const response=await media.serve(db,shared.split("/").pop()!,false);expect(new Uint8Array(await response!.arrayBuffer())).toEqual(clean);
 });
}
it("discards text and XMP without parsing XML or inflating compressed comments",()=>{
 const marker=new TextEncoder().encode('GPSLatitude="12.34" <!DOCTYPE x SYSTEM "https://example.com/">');
 const jpeg=get("gps.jpeg"),app=new Uint8Array(marker.length+4);app.set([255,225,(marker.length+2)>>8,(marker.length+2)&255]);app.set(marker,4);
 const joined=(...p:Uint8Array[])=>{const b=new Uint8Array(p.reduce((s,x)=>s+x.length,0));let n=0;for(const x of p){b.set(x,n);n+=x.length;}return b;};
 expect(stripLocation(joined(jpeg.slice(0,2),app,jpeg.slice(2)),"image/jpeg")).toEqual(stripLocation(jpeg,"image/jpeg"));
 for(const type of ["tEXt","iTXt","zTXt"]){const b=get("gps.png"),chunk=new Uint8Array(marker.length+12);new DataView(chunk.buffer).setUint32(0,marker.length);chunk.set(new TextEncoder().encode(type),4);chunk.set(marker,8);expect(stripLocation(joined(b.slice(0,33),chunk,b.slice(33)),"image/png")).toEqual(stripLocation(b,"image/png"));}
 const b=get("gps.webp"),chunk=new Uint8Array(8+marker.length+marker.length%2);chunk.set([88,77,80,32]);new DataView(chunk.buffer).setUint32(4,marker.length,true);chunk.set(marker,8);const input=joined(b,chunk);new DataView(input.buffer).setUint32(4,input.length-8,true);expect(stripLocation(input,"image/webp")).toEqual(stripLocation(b,"image/webp"));
});
