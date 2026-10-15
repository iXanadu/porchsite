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

it("preserves metadata-free PNGs with many empty pixel chunks",()=>{
 const plain=get("plain.png"),empty=new Uint8Array([0,0,0,0,73,68,65,84,53,175,6,30]);
 const input=new Uint8Array(plain.length+5000*empty.length);input.set(plain.subarray(0,plain.length-12));
 for(let n=0;n<5000;n++)input.set(empty,plain.length-12+n*empty.length);
 input.set(plain.subarray(plain.length-12),input.length-12);
 expect(stripLocation(input,"image/png")).toBe(input);
});

it("stores the 4121-IDAT PNG byte-for-byte with its original dimensions",async()=>{
 const db=(env as unknown as Env).DB,b=get("many-idat.png");
 expect(b.length).toBe(61860);expect(stripLocation(b,"image/png")).toBe(b);
 const added=await imageAdd(db,"assistant:test",b.toBase64()),path="image" in added?added.image!:"";
 expect(added).toMatchObject({width:64,height:64});
 const served=await media.serve(db,path.split("/").pop()!,false);expect(new Uint8Array(await served!.arrayBuffer())).toEqual(b);
});
const join=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,b)=>n+b.length,0));let at=0;for(const b of parts){out.set(b,at);at+=b.length;}return out;};
const text=(s:string)=>new TextEncoder().encode(s);
function pngChunk(name:string,data:Uint8Array){const out=join(new Uint8Array(4),text(name),data,new Uint8Array(4)),view=new DataView(out.buffer);view.setUint32(0,data.length);let crc=0xffffffff;for(const b of out.subarray(4,out.length-4)){crc^=b;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}view.setUint32(out.length-4,(crc^0xffffffff)>>>0);return out;}
function webChunk(name:string,data:Uint8Array){const out=join(text(name),new Uint8Array(4),data,new Uint8Array(data.length%2));new DataView(out.buffer).setUint32(4,data.length,true);return out;}
it("keeps JPEG APP2, PNG iCCP and WebP ICCP profile bytes",()=>{
 const profile=text("opaque colour profile"),j=get("gps.jpeg"),payload=join(text("ICC_PROFILE\0"),new Uint8Array([1,1]),profile),header=new Uint8Array([255,226,0,payload.length+2]),app=join(header,payload);
 expect(stripLocation(join(j.slice(0,2),app,j.slice(2)),"image/jpeg").toHex()).toContain(app.toHex());
 const p=get("gps.png"),icc=pngChunk("iCCP",join(text("profile\0\0"),profile));
 expect(stripLocation(join(p.slice(0,33),icc,p.slice(33)),"image/png").toHex()).toContain(icc.toHex());
 const w=get("gps.webp"),chunk=webChunk("ICCP",profile),input=join(w,chunk);new DataView(input.buffer).setUint32(4,input.length-8,true);
 expect(stripLocation(input,"image/webp").toHex()).toContain(chunk.toHex());
});
it("keeps more than 4096 non-metadata JPEG and WebP segments, including packet-like payloads",()=>{
 const j=get("plain.jpeg"),app=new Uint8Array([255,226,0,4,255,225]),many=new Uint8Array(app.length*5000);for(let n=0;n<5000;n++)many.set(app,n*app.length);
 const jpeg=join(j.slice(0,2),many,j.slice(2));expect(stripLocation(jpeg,"image/jpeg")).toBe(jpeg);
 const w=get("plain.webp"),chunk=webChunk("JUNK",text("EXIF")),chunks=new Uint8Array(chunk.length*5000);for(let n=0;n<5000;n++)chunks.set(chunk,n*chunk.length);
 const webp=join(w,chunks,webChunk("fAk!",text("EXIF")));new DataView(webp.buffer).setUint32(4,webp.length-8,true);expect(stripLocation(webp,"image/webp")).toBe(webp);
});

it("walks the many-IDAT image with GPS metadata and preserves all its pixel chunks",()=>{
 const b=get("many-idat.png"),gps=parts(get("gps.png"),"png").find(p=>p.name==="eXIf")!.data;
 const result=stripLocation(join(b.slice(0,33),pngChunk("eXIf",gps),b.slice(33)),"image/png");
 expect(exif(result,"png")?.toHex()).toBe(minimal);expect(encoded(result,"png")).toEqual(encoded(b,"png"));
});
