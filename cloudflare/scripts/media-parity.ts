/** Byte/status/header parity for binary media validators, including malformed lists. */
import cases from "../../spec/media-http-cases.json";
import { conditionalMedia, mediaSession } from "../src/media-http";

async function main() {
  const out = [];
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    const url = "https://example.com/media/0123456789abcdef0123456789abcdef." + type.split("/")[1];
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 254]);
    const make = () => new Response(bytes, {headers:{"Content-Type":type,"Cache-Control":"no-cache, no-transform","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'"}});
    const tag = (await conditionalMedia(new Request(url), make(), url)).headers.get("ETag")!;
    for (const c of cases) for (const method of ["GET", "HEAD"]) {
      const headers: Record<string,string> = {};
      if(c.value !== null) headers["If-None-Match"] = c.value.replaceAll("$tag",tag).replaceAll("$strong",tag.slice(2));
      const r = await conditionalMedia(new Request(url,{method,headers}),make(),url);
      const body = [...new Uint8Array(await r.arrayBuffer())];
      out.push({type,case:c.name,method,status:r.status,tag:r.headers.get("ETag"),cache:r.headers.get("Cache-Control"),headers:Object.fromEntries(r.headers),body:method==="HEAD"?[]:body});
    }
  }
  const sessions = ["__Host-sk_owner=x","__Host-sk_reader=x","other=__Host-sk_reader=x","a=1; __Host-sk_reader=x"].map(Cookie=>mediaSession(new Request("https://example.com",{headers:{Cookie}})));
  console.log(JSON.stringify({responses:out,sessions}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
