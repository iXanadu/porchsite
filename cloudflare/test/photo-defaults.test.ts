import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { PHOTO_ADVICE, photoNext } from "../src/photo-advice";
import { imageAdd } from "../src/image-add";
import type { Env } from "../src/env";
const MB=1024*1024, NEXT="Put image in an image field with a description, then ask for approval as usual.";
it("adds exactly one advice line for oversized input positions",()=>{
 expect(photoNext(NEXT,[MB],false)).toBe(NEXT);
 expect(photoNext(NEXT,[MB+1],false)).toBe(`${NEXT}\nThis picture is 1.00 MB. ${PHOTO_ADVICE}`);
 expect(photoNext(NEXT,[MB*1.125],false)).toBe(`${NEXT}\nThis picture is 1.13 MB. ${PHOTO_ADVICE}`);
 expect(photoNext(NEXT,[24,MB*1.125,MB*1.125],true)).toBe(`${NEXT}\nPictures over 1 MB: 2 (1.13 MB), 3 (1.13 MB). ${PHOTO_ADVICE}`);
});
it("keeps image response fields and small next unchanged, advising only for big stored files",async()=>{
 const db=(env as unknown as Env).DB;
 const png=(length:number)=>{const b=new Uint8Array(length);b.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);return b.toBase64();};
 const small=await imageAdd(db,"assistant:test",png(24));
 expect(Object.keys(small)).toEqual(["image","width","height","next"]);
 expect(small.next).toBe(NEXT);
 const large=png(MB+1);
 const result=await imageAdd(db,"assistant:test",undefined,[png(24),large,large]);
 expect(Object.keys(result)).toEqual(["images","next"]);
 expect(result.images).toHaveLength(3);
 expect(result.images![1]).toEqual(result.images![2]);
 expect(result.next).toBe(`${NEXT}\nPictures over 1 MB: 2 (1.00 MB), 3 (1.00 MB). ${PHOTO_ADVICE}`);
});
