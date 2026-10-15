/** Engine-owned blocks. Content holds URLs, never active iframe markup. */
import { esc, markdown } from "./html";
import { embedSources, embedURL, requestOrigin } from "./embed-url";

export interface Embed { url: string; title: string; origin: string }
// Boxed strings render/serialize as strings. Their private capabilities are
// held weakly, outside the template's enumerable view and content data.
const capabilities = new WeakMap<object, Map<string, Embed>>();
function renderMarkers(view: unknown, out = new Map<string, Embed>(), seen = new Set<object>()): Map<string, Embed> {
  if (!view || typeof view !== "object" || seen.has(view)) return out;
  seen.add(view);
  const own = capabilities.get(view);
  if (own) { for (const [key, value] of own) out.set(key, value); return out; }
  for (const value of Object.values(view)) renderMarkers(value, out, seen);
  return out;
}
export function embedLine(line: string): Embed | null {
  const m = /^!embed\[([^\[\]\r\n]{1,200})\]\(([^()\r\n]{1,2000})\)$/.exec(line);
  if (!m || !m[1].trim() || /[\ud800-\udfff]/u.test(m[1])) return null;
  try { const u = embedURL(m[2]); return {url:u.href, title:m[1], origin:u.origin}; } catch { return null; }
}
export function bodyMarkdown(src: string, visit?: (e: Embed) => void, headingIds = false): string {
  if (!src.includes("!embed[")) return markdown(src, undefined, headingIds).html;
  const markers = new Map<string, Embed>();
  const html = markdown(src, line => {
    const e = embedLine(line); if (!e) return null;
    visit?.(e);
    const key = crypto.randomUUID(); markers.set(key, e);
    return `<porchsite-embed data-key="${key}" data-url="${encodeURIComponent(e.url)}" data-title="${encodeURIComponent(e.title)}"></porchsite-embed>`;
  }, headingIds).html;
  if (!markers.size) return html;
  const result = new String(html); capabilities.set(result, markers);
  return result as unknown as string;
}
/** Regenerate only engine Markdown bodies; genuine embed provenance stays private. */
export function headingBodies(value: unknown, bodies = new Map<string, string>()): any {
  if (Array.isArray(value)) return value.map(child => headingBodies(child, bodies));
  if (!value || typeof value !== "object" || value instanceof String) return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(source).map(([key, child]) => {
    if (key === "body_html" && child && typeof source.body === "string") {
      if (!bodies.has(source.body)) bodies.set(source.body, bodyMarkdown(source.body, undefined, true));
      return [key, bodies.get(source.body)];
    }
    return [key, headingBodies(child, bodies)];
  }));
}
export function embedsOf(src: string): Embed[] {
  const out: Embed[] = []; if (src.includes("!embed[")) bodyMarkdown(src, e => out.push(e)); return out;
}
export function safeSources(values: unknown, origin = ""): string[] {
  if (!Array.isArray(values)) return [];
  try { return embedSources(values).filter(s => s !== requestOrigin(origin)); } catch { return []; }
}
export const PERMISSIONS = "camera=(), microphone=(), geolocation=(), payment=(), display-capture=(), publickey-credentials-get=()";
export function frameCsp(csp: string, sources: unknown, origin: string): string {
  const list = safeSources(sources, origin); return csp + (list.length ? `; frame-src ${list.join(" ")}` : "");
}
const MARKER = /^<porchsite-embed(?: data-key="([a-f0-9-]{36})")? data-url="([^"]*)" data-title="([^"]*)"><\/porchsite-embed>$/;
const TOKENS = /<porchsite-embed(?: data-key="[a-f0-9-]{36}")? data-url="[^"]*" data-title="[^"]*"><\/porchsite-embed>|<!--[\s\S]*?(?:-->|$)|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
/** Process dangerous tags independently of comments/raw-text interpretation.
 * Spaces prevent deletion from joining fragments into another element. */
function withoutAuthoredFrames(body:string):string {
  // Rename prefixes first, so even an unfinished quote/comment cannot leave
  // an active tag behind if the complete-tag matcher cannot consume it.
  const inert = body.replace(/(<\/?)(iframe|object|embed|frame)\b/gi, "$1porchsite-inert-$2");
  return inert.replace(/<\/?porchsite-inert-(?:iframe|object|embed|frame)\b(?:"[^"]*"|'[^']*'|[^'">])*(?:>|$)/gi, tag => {
    if (tag.startsWith("</")) return " ";
    const attr = /\b(?:src|data|cite)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (attr) try { const u=embedURL(attr[1]??attr[2]??attr[3]); return `<a href="${esc(u.href)}">${esc(u.href)}</a>`; } catch { /* Keep only text. */ }
    return " ";
  });
}
/** Count only selected occurrences, outside inert/raw-text elements. */
export function finishEmbeds(body: string, sources: unknown = [], origin = "", view: unknown = body): string {
  body = withoutAuthoredFrames(String(body));
  if (!body.includes("<porchsite-embed ")) return body;
  const markers = renderMarkers(view);
  const allowed = new Set(safeSources(sources, origin));
  let count = 0, templates = 0, noscript = false, rawText = "";
  return body.replace(TOKENS, token => {
    const tag = /^<\s*(\/?)\s*([a-z0-9-]+)/i.exec(token);
    if (rawText) { if (tag?.[1] && tag[2].toLowerCase() === rawText) rawText = ""; return token; }
    if (token.startsWith("<!--")) return token;
    const marker = MARKER.exec(token);
    if (marker) {
      let e = marker[1] ? markers.get(marker[1]) : undefined;
      const genuine = !!e;
      if (!e && marker) try { const u = embedURL(decodeURIComponent(marker[2])); e = {url:u.href,title:decodeURIComponent(marker[3]),origin:u.origin}; } catch { return ""; }
      if (!e) return "";
      const link = `<a href="${esc(e.url)}">${esc(e.title)}</a>`;
      if (!genuine || templates || noscript || !allowed.has(e.origin) || count >= 12) return `<div class="embed">${link}</div>`;
      count++;
      return `<div class="embed"><iframe src="${esc(e.url)}" title="${esc(e.title)}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen; xr-spatial-tracking" style="width:100%;aspect-ratio:16/9;border:0"></iframe>${link}</div>`;
    }
    if (noscript) {
      if (tag?.[1] && tag[2].toLowerCase() === "noscript") noscript = false;
      return token;
    }
    if (tag) {
      const name = tag[2].toLowerCase();
      if (name === "noscript" && !tag[1]) noscript = true;
      if (name === "template") templates = Math.max(0,templates+(tag[1] ? -1 : 1));
      if (!tag[1] && ["script","style","textarea","title","xmp","iframe","noembed","noframes"].includes(name)) rawText = name;
    }
    return token;
  });
}

export function embedNotes(entries: Record<string, any>[], sources: unknown, origin: string) {
  const live = new Set(safeSources(sources, origin));
  return entries.flatMap(e => embedsOf(String(e.body ?? "")).filter(b => !live.has(b.origin)).map(b => ({id:e.id,url:b.url,origin:b.origin,note:b.origin === requestOrigin(origin) ? "Use a source on another site; this source is this site's own origin." : "Ask the owner to approve this embed source."})));
}
