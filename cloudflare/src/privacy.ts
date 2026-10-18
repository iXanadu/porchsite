import {dailyAccess} from './daily-limit';
/** Access is checked before any content view or existence lookup. */
import * as owner from "./owner";
export const BLANK = '<!doctype html><meta name="robots" content="noindex"><title></title>';
export const SIGN_IN = BLANK+'<a href="/login?next=%2Freview">Sign in</a>';
/** Presentation only: never a content, existence or authorization lookup. */
export function denialBody(req?:Request){return req&&['GET','HEAD'].includes(req.method)&&!req.headers.has('Authorization')?SIGN_IN:BLANK;}
export const BLANK_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";
export const PRIVATE_HEADERS = {"Cache-Control":"private, no-store, no-transform"};
export const ROLLBACK_WARNING = "This makes the site public. Older releases cannot keep this site private. Use the minimum release or a newer one, or turn private off first on purpose. Continue only after the owner explicitly agrees to make the site public.";
export async function livePrivate(db: D1Database): Promise<boolean> {
 return dailyAccess(async()=>{
  const row = await db.prepare("SELECT f.value FROM live l JOIN site_fields f ON f.version = l.version AND f.key = 'private' AND f.approved = 1 JOIN private_approvals a ON a.version = l.version WHERE l.item_id = 'site'").first<any>();
  return !!row && JSON.parse(row.value) === true;
 });
}
export async function privateFloor(db: D1Database, release: string): Promise<string | null> {
 return dailyAccess(async()=>{
  if (!(await livePrivate(db))) return null;
  if (/^\d{4}\.\d{2}\.\d{2}-[a-f0-9]+$/.test(release)) await db.prepare("UPDATE auth_state SET private_floor = ? WHERE id = 1 AND private_floor = ''").bind(release).run();
  return (await db.prepare("SELECT private_floor FROM auth_state WHERE id = 1").first<string>("private_floor")) || "unknown";
 });
}
export async function rollbackState(db: D1Database, release: string) {
  const floor = await privateFloor(db,release);
  return {private_floor:floor, explanation:floor ? ROLLBACK_WARNING : ""};
}
export function openPath(path: string, method: string) {
  const m = method === "HEAD" ? "GET" : method;
  if (["/mcp","/authorize","/oauth/token","/oauth/register","/.well-known/oauth-authorization-server","/.well-known/oauth-protected-resource","/.well-known/oauth-protected-resource/mcp"].includes(path)) return true;
  if (m === "GET" && ["/login","/setup","/recover","/.well-known/porchsite-release","/sw.js","/manifest.webmanifest","/app-icon-192.png","/app-icon-512.png"].includes(path)) return true;
  if (m === "POST" && /^\/(?:login|setup|recover)\/(?:options|verify)$/.test(path)) return true;
  if (/^\/upload\/[A-Za-z0-9_-]{32}$/.test(path)) return m === "GET" || m === "POST";
  if (/^\/(?:passkey|invite)\/[A-Za-z0-9_-]{32}$/.test(path)) return m === "GET";
  return m === "POST" && /^\/(?:passkey|invite)\/[A-Za-z0-9_-]{32}\/(?:options|verify)$/.test(path);
}

export async function access(db: D1Database, req: Request) {
  const path = new URL(req.url).pathname, isPrivate = await livePrivate(db);
  const gated = !openPath(path,req.method);
  let response: Response | null = null;
  if (isPrivate && path === "/robots.txt") response = new Response("User-agent: *\nDisallow: /\n",{headers:{...PRIVATE_HEADERS,"Content-Type":"text/plain; charset=utf-8"}});
  else if ((isPrivate && gated) || path === "/authorize") {
    const isOwner = await owner.signedIn(db,req);
    const reader = !isOwner && await owner.readerSignedIn(db,req);
    if (reader && (path === "/authorize" || path === "/review" || path.startsWith("/review/"))) response = new Response(null,{status:303,headers:{Location:"/",...PRIVATE_HEADERS}});
    else if (isPrivate && gated && !isOwner && !reader) response = path === "/collect" ? new Response(null,{status:204,headers:PRIVATE_HEADERS}) : blankResponse(req);
  }
  return {isPrivate,gated,response};
}
export function noStore(response: Response): Response {
  const out = new Response(response.body,response);
  out.headers.set("Cache-Control","private, no-store, no-transform");out.headers.delete("ETag");out.headers.delete("Last-Modified");
  return out;
}

export async function withRollback(db: D1Database, release: string, state: Record<string,unknown>) {
  const rollback = await rollbackState(db,release);
  return rollback.private_floor ? {...state,rollback} : state;
}

export class PrivateContentDenied extends Error {}
export function blankResponse(req?:Request) {
  const body=denialBody(req);
  return new Response(body,{status:404,headers:{...PRIVATE_HEADERS,"X-Robots-Tag":"noindex","Content-Security-Policy":BLANK_CSP,"Content-Type":"text/html; charset=utf-8",...(body===SIGN_IN?{"X-Content-Type-Options":"nosniff"}:{})}});
}
export async function requireContent(db: D1Database, req: Request) {
  if (await livePrivate(db) && !await owner.signedIn(db,req) && !await owner.readerSignedIn(db,req)) throw new PrivateContentDenied();
}
