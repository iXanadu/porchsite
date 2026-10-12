/**
 * Read-only demo sites: one per look, at <look>-demo.<domain>, each the
 * look's own sample.json rendered on request (so "open now" and upcoming
 * events stay true). No database, no owner, nothing to change. A bar on top
 * says it's a demo, credits the look's maker (an X handle from
 * themes/credits.json, when there is one) and lets a visitor try the look's
 * palettes.
 */
import { RELEASE } from "../src/home";
import { sampleView } from "../src/themecheck";
import * as theme from "../src/theme";
import { THEMES } from "../src/themes.gen";
import { creditHtml } from "./credit";
import { CREDITS, SAMPLES } from "./samples.gen";

const CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Render only the page asked for, from a view built once per look per isolate
// and kept ten minutes (so "open now" and upcoming events stay roughly true).
const views = new Map<string, { at: number; v: ReturnType<typeof sampleView> }>();
const pageMemo = new Map<string, { at: number; html: string; status: number }>();
function pageFor(look: string, t: any, sample: any, path: string, origin: string): { html: string; status: number } {
  const key = `${look}|${origin}|${path}`;
  const hit = pageMemo.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
  let vh = views.get(look);
  if (!vh || Date.now() - vh.at >= 10 * 60_000) {
    vh = { at: Date.now(), v: sampleView(t, sample) };
    views.set(look, vh);
  }
  const v = vh.v;
  const p = path.endsWith("/") ? path : `${path}/`;
  let html = "";
  let status = 200;
  if (p === "/") html = theme.render(t, "home", theme.homeView(v, "1", origin));
  else {
    const e = v.entries.find((x: any) => !x.external_url && x.page === p);
    if (e) html = theme.render(t, "entry", theme.entryView(v, e, "1", origin));
    else {
      const m = /^\/([a-z][a-z0-9-]{0,29})\/(?:tags\/([a-z0-9-]{1,30})\/)?$/.exec(p);
      const av = m ? theme.archiveView(v, m[1], "1", origin, m[2]) : null;
      if (av && (!m![2] || av.entries.length)) html = theme.render(t, m![2] ? "tag" : "archive", av);
    }
  }
  if (!html) {
    html = theme.render(t, "not_found", theme.notFoundView(v, "1", origin));
    status = 404;
  }
  const out = { at: Date.now(), html, status };
  pageMemo.set(key, out);
  return out;
}
const cssMemo = new Map<string, string>();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" })[c]!);

const credit = (look: string) => creditHtml(Object.prototype.hasOwnProperty.call(CREDITS, look) ? CREDITS[look] : undefined);

export default {
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const look = u.hostname.split(".")[0].replace(/-demo$/, "");
    const t = THEMES[look];
    const sample = SAMPLES[look];
    if (!t || !sample) return new Response("No demo here.", { status: 404 });
    if (u.searchParams.has("palette") && !Object.keys(t.manifest.palettes ?? {}).length) return Response.redirect(`${u.origin}${u.pathname}`, 302);
    const feed = /^\/([a-z][a-z0-9-]{0,29})\/feed\.xml$/.exec(u.pathname);
    if (feed) {
      const r = theme.feed(sampleView(t, sample), feed[1], u.origin);
      return r ?? new Response("", { status: 404 });
    }
    if (u.pathname === "/__demo/link") {
      const to = u.searchParams.get("to") ?? "";
      let where = "another site";
      try {
        const x = new URL(to);
        where = x.host + (x.pathname === "/" ? "" : x.pathname);
      } catch {}
      // In the demo's own colours: the chosen palette (or the look's first).
      const pals = (t.manifest.palettes ?? {}) as Record<string, { colors: Record<string, string> }>;
      const chosen = (req.headers.get("Cookie") ?? "").match(/(?:^|; )palette=([a-z0-9-]+)/)?.[1] ?? "";
      const c = (pals[chosen] ?? Object.values(pals)[0])?.colors ?? { bg: "#f3f2f2", ink: "#201e1d", muted: "#5c5653", accent: "#00647f" };
      const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>A demo link</title>
<style>body{margin:0;background:${c.bg};color:${c.ink};font:18px/1.55 Georgia,serif}main{max-width:34em;margin:0 auto;padding:48px 16px}p{color:${c.muted}}b{color:${c.ink}}a{color:${c.accent}}</style></head>
<body><div style="background:#1c1f1d;color:#fff;font:14px/1.4 -apple-system,sans-serif;padding:8px 16px">Demo of the <b style="color:#fff">${esc(String(t.manifest.title))}</b> look${credit(look)}, with made-up content. <a style="color:#9fd8c4" href="https://porchsite.dev/">Porchsite</a></div>
<main><h1>This is a demo link</h1><p>On a real site, this button goes to the owner's own page for it (here it pointed at <b>${esc(where)}</b>, a made-up address).</p><p><a href="/">Back to the demo</a></p></main></body></html>`;
      return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP, "X-Robots-Tag": "noindex", "Cache-Control": "no-cache", "X-Porchsite-Release": RELEASE } });
    }
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain" } });
    if (u.pathname.startsWith("/static/")) {
      const f = theme.staticFile(t, u.pathname.slice(8), "");
      return f ?? new Response("", { status: 404 });
    }
    const palettes = Object.entries((t.manifest.palettes ?? {}) as Record<string, { title: string }>);
    const asked = u.searchParams.get("palette") ?? (req.headers.get("Cookie") ?? "").match(/(?:^|; )palette=([a-z0-9-]+)/)?.[1] ?? "";
    const palette = palettes.some(([n]) => n === asked) ? asked : (palettes[0]?.[0] ?? "");
    const page = pageFor(look, t, sample, u.pathname, u.origin);
    let html = page.html;
    const status = page.status;
    // The look's stylesheet with the chosen palette, inline.
    const cssKey = `${look}|${palette}`;
    let css = cssMemo.get(cssKey);
    if (css === undefined) {
      css = await theme.staticFile(t, "site.css", palette)!.text();
      cssMemo.set(cssKey, css);
    }
    html = html.replace(/<link rel="stylesheet" href="\/static\/site\.css[^"]*">/, () => `<style>${css}</style>`);
    const chips = palettes
      .map(([n, p]) => `<a href="?palette=${n}" style="color:#fff;margin-left:10px;${n === palette ? "font-weight:700;text-decoration:underline" : "opacity:.8"}">${esc(p.title)}</a>`)
      .join("");
    // No click leaves the demo: every outside link goes to a page that says where it would go.
    html = html.replace(/href="(https?:\/\/[^"]+)"/g, (m, url: string) => {
      try {
        const to = new URL(url.replace(/&amp;/g, "&"));
        if (to.host === u.host || /(^|\.)porchsite\.dev$/.test(to.host) || /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(to.host)) return m;
        return `href="/__demo/link?to=${encodeURIComponent(to.href)}"`;
      } catch {
        return m;
      }
    });
    // The bar goes in after that, so its links (Porchsite, the maker's X profile) leave as they say.
    const bar = `<div style="background:#1c1f1d;color:#fff;font:14px/1.4 -apple-system,sans-serif;padding:8px 16px;display:flex;flex-wrap:wrap;gap:6px;justify-content:space-between"><span>Demo of the <b>${esc(String(t.manifest.title))}</b> look${credit(look)}, with made-up content. <a style="color:#9fd8c4" href="https://porchsite.dev/">Porchsite</a></span>${palettes.length > 1 ? `<span>Colours:${chips}</span>` : ""}</div>`;
    html = html.replace(/<body([^>]*)>/, (_m, attrs: string) => `<body${attrs}>${bar}`);
    const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "Content-Security-Policy": CSP, "X-Robots-Tag": "noindex", "X-Porchsite-Release": RELEASE };
    if (u.searchParams.has("palette")) headers["Set-Cookie"] = `palette=${palette}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
    return new Response(html, { status, headers });
  },
};
