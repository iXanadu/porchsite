/** Access is checked before any content view or existence lookup. */
import * as owner from "./owner";
export const BLANK = '<!doctype html><meta name="robots" content="noindex"><title></title>';
export const PRIVATE_HEADERS = {"Cache-Control":"private, no-store"};
export const ROLLBACK_WARNING = "This makes the site public. Older releases cannot keep this site private. Use the minimum release or a newer one, or turn private off first on purpose. Continue only after the owner explicitly agrees to make the site public.";
export async function livePrivate(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT f.value FROM live l JOIN site_fields f ON f.version = l.version AND f.key = 'private' AND f.approved = 1 JOIN private_approvals a ON a.version = l.version WHERE l.item_id = 'site'").first<any>();
  return !!row && JSON.parse(row.value) === true;
}
export async function privateFloor(db: D1Database, release: string): Promise<string | null> {
  if (!(await livePrivate(db))) return null;
  if (/^\d{4}\.\d{2}\.\d{2}-[a-f0-9]+$/.test(release)) await db.prepare("UPDATE auth_state SET private_floor = ? WHERE id = 1 AND private_floor = ''").bind(release).run();
  return (await db.prepare("SELECT private_floor FROM auth_state WHERE id = 1").first<string>("private_floor")) || "unknown";
}
export async function rollbackState(db: D1Database, release: string) {
  const floor = await privateFloor(db,release);
  return {private_floor:floor, explanation:floor ? ROLLBACK_WARNING : ""};
}
export function openPath(path: string) {
  return /^\/(?:login|setup|recover)(?:\/|$)/.test(path) || /^\/(?:oauth|\.well-known|upload|passkey|invite)(?:\/|$)/.test(path) || path === "/mcp" || path === "/authorize";
}
export async function access(db: D1Database, req: Request) {
  const path = new URL(req.url).pathname, isPrivate = await livePrivate(db);
  const gated = !openPath(path);
  let response: Response | null = null;
  if (isPrivate && path === "/robots.txt") response = new Response("User-agent: *\nDisallow: /\n",{headers:{...PRIVATE_HEADERS,"Content-Type":"text/plain; charset=utf-8"}});
  else if ((isPrivate && gated) || path === "/authorize") {
    const isOwner = await owner.signedIn(db,req);
    const reader = !isOwner && await owner.readerSignedIn(db,req);
    if (reader && (path === "/authorize" || path === "/review" || path.startsWith("/review/"))) response = new Response(null,{status:303,headers:{Location:"/",...PRIVATE_HEADERS}});
    else if (isPrivate && gated && !isOwner && !reader) response = path === "/collect" ? new Response(null,{status:204,headers:PRIVATE_HEADERS}) : new Response(BLANK,{status:404,headers:{...PRIVATE_HEADERS,"X-Robots-Tag":"noindex","Content-Type":"text/html; charset=utf-8"}});
  }
  return {isPrivate,gated,response};
}
export function noStore(response: Response): Response {
  const out = new Response(response.body,response);
  out.headers.set("Cache-Control","private, no-store");out.headers.delete("ETag");out.headers.delete("Last-Modified");
  return out;
}

export async function withRollback(db: D1Database, release: string, state: Record<string,unknown>) {
  const rollback = await rollbackState(db,release);
  return rollback.private_floor ? {...state,rollback} : state;
}
