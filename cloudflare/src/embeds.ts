/** Engine-owned blocks. Content holds URLs, never active iframe markup. */
import { esc, markdown } from "./html";
import { embedSources, embedURL, requestOrigin } from "./embed-url";

export interface Embed { url: string; title: string; origin: string }
export function embedLine(line: string): Embed | null {
  const m = /^!embed\[([^\[\]\r\n]{1,200})\]\(([^()\r\n]{1,2000})\)$/.exec(line);
  if (!m || !m[1].trim() || /[\ud800-\udfff]/u.test(m[1])) return null;
  try { const u = embedURL(m[2]); return {url:u.href, title:m[1], origin:u.origin}; } catch { return null; }
}
export function bodyMarkdown(src: string, visit?: (e: Embed) => void): string {
  if (!src.includes("!embed[")) return markdown(src).html;
  return markdown(src, line => {
    const e = embedLine(line); if (!e) return null;
    visit?.(e);
    try { return `<porchsite-embed data-url="${encodeURIComponent(e.url)}" data-title="${encodeURIComponent(e.title)}"></porchsite-embed>`; }
    catch { return null; }
  }).html;
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
const MARKER = /^<porchsite-embed data-url="([^"]*)" data-title="([^"]*)"><\/porchsite-embed>$/;
const TOKENS = /<porchsite-embed data-url="[^"]*" data-title="[^"]*"><\/porchsite-embed>|<!--[\s\S]*?(?:-->|$)|<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
/** Neutralise authored frames even in malformed HTML/comments in old looks.
 * Engine frames are created only AFTER this pass. A template is inert and
 * cannot fetch its src or execute its fallback contents. */
function withoutAuthoredFrames(body:string):string {
  return body.replace(/<\/?iframe\b/gi, tag => tag.startsWith("</") ? "</template" : "<template");
}
/** Count only selected occurrences, outside inert/raw-text elements. */
export function finishEmbeds(body: string, sources: unknown = [], origin = ""): string {
  body = withoutAuthoredFrames(body);
  if (!body.includes("<porchsite-embed ")) return body;
  const allowed = new Set(safeSources(sources, origin));
  let count = 0, templates = 0, noscript = false, rawText = "";
  return body.replace(TOKENS, token => {
    const tag = /^<\s*(\/?)\s*([a-z0-9-]+)/i.exec(token);
    if (rawText) { if (tag?.[1] && tag[2].toLowerCase() === rawText) rawText = ""; return token; }
    if (token.startsWith("<!--")) return token;
    const marker = MARKER.exec(token);
    if (marker) {
      let e: Embed;
      try { const u = embedURL(decodeURIComponent(marker[1])); e = {url:u.href,title:decodeURIComponent(marker[2]),origin:u.origin}; } catch { return ""; }
      const link = `<a href="${esc(e.url)}">${esc(e.title)}</a>`;
      if (templates || noscript || !allowed.has(e.origin) || count >= 12) return `<div class="embed">${link}</div>`;
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
