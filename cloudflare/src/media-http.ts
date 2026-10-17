/** Conditional media responses. Call only after access and publication checks. */
import { matchesTag } from "./public-http";
export { sessionRequest as mediaSession } from "./public-http";

export async function conditionalMedia(req: Request, response: Response, canonicalUrl: string): Promise<Response> {
  const body = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  const prefix = new TextEncoder().encode(`${canonicalUrl}\0${headers.get("Content-Type") ?? ""}\0${headers.get("Content-Signal") ?? ""}\0`);
  const input = new Uint8Array(prefix.length + body.length);
  input.set(prefix); input.set(body, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const tag = `W/"sha256-${[...digest].map(b => b.toString(16).padStart(2, "0")).join("")}"`;
  headers.set("ETag", tag);
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.delete("Last-Modified"); headers.delete("Content-Length");
  const matched = matchesTag(req.headers.get("If-None-Match"), tag);
  if (!matched) headers.set("Content-Length", String(body.length));
  return new Response(matched ? null : body, { status: matched ? 304 : 200, headers });
}
