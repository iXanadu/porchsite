/**
 * Everything that isn't /mcp or the OAuth protocol endpoints: the public
 * site, and the owner's pages (setup, sign-in, review, connecting an
 * assistant). Owner pages are server-rendered; the only script is the
 * passkey call, under a nonce.
 */
import {sitemap, robots, SITEMAP_HEADERS} from "./sitemap";
import { embedReview } from "./embed-review";
import { frameCsp, PERMISSIONS } from "./embeds";
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import * as analytics from "./analytics";
import * as alerts from "./alerts";
import { ALERT_JS, SW_JS, ICONS } from "./alert-assets";
import * as approvals from "./approvals";
import { BEACON_JS } from "./beacon";
import * as changes from "./changes";
import * as content from "./content";
import * as desk from "./desk";
import type { Env } from "./env";
import { ApiError } from "./errors";
import * as history from "./history";
import * as importer from "./importer";
import * as keys from "./keys";
import { esc, html, markdown, nonce, type Raw, raw, respond } from "./html";
import * as media from "./media";
import * as owner from "./owner";
import * as privacy from "./privacy";
import { dateString } from "./date-format";
import { RELEASE } from "./home";
import * as requests from "./requests";
import * as sharecards from "./sharecards";
import * as site from "./site";
import * as theme from "./theme";
import * as themes from "./themes";
import * as update from "./update";
import * as uploads from "./uploads";
import * as visibility from "./visibility";

const OWNER_CSS = `
:root{--bg:#f4f1ea;--card:#fbfaf6;--ink:#1c1f1d;--muted:#4a4f4b;--rule:#d8d2c4;--accent:#2e5b4b;--deny:#8a2f1f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 -apple-system,"Segoe UI",sans-serif}
.wrap{max-width:680px;margin:0 auto;padding:0 18px 64px}header{display:flex;justify-content:space-between;align-items:center;min-height:56px;border-bottom:1px solid var(--rule);margin-bottom:24px}
header a{color:var(--accent);margin-left:14px}h1{font-family:Georgia,serif;font-size:28px;margin:0 0 10px}h2{font-family:Georgia,serif;font-size:20px;margin:0 0 6px}
.card{background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:18px;margin:14px 0}.meta{font:13px ui-monospace,Menlo,monospace;color:var(--muted)}
label{display:block;margin:14px 0 6px;color:var(--muted)}input[type=text],input[type=password],textarea{width:100%;font:inherit;padding:12px;border:1px solid var(--rule);border-radius:6px;background:#fff}
button{font:inherit;font-weight:600;min-height:50px;border-radius:6px;border:0;padding:0 20px;cursor:pointer;background:var(--accent);color:#fff;width:100%;margin-top:14px}
button.ghost{background:transparent;color:var(--deny);border:1px solid var(--deny)}.error{background:#f3dcd6;color:var(--deny);padding:12px;border-radius:6px}
.field{margin-top:12px}.field b{display:block;font:12px ui-monospace,Menlo,monospace;color:var(--muted);text-transform:uppercase}.value{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}.value img,.card img{max-width:100%;height:auto}
.old{color:var(--muted);text-decoration:line-through}.choice label{display:flex;gap:10px;align-items:center;margin:6px 0;color:var(--ink)}a.card{display:block;color:inherit;text-decoration:none}
.go{display:inline-block;margin-top:12px;font-weight:600;color:var(--accent)}
a.button{display:block;text-align:center;font-weight:600;min-height:50px;line-height:50px;border-radius:6px;border:2px solid var(--accent);color:var(--accent);text-decoration:none;margin:10px 0 18px}
summary{padding:6px 0}
.tag{font:12px ui-monospace,Menlo,monospace;text-transform:uppercase;background:#efe7dc;padding:4px 8px;border-radius:4px}
header{flex-wrap:wrap;gap:6px 0}.warn{background:#efe7dc;color:#6b3f12;padding:12px;border-radius:6px}.ok{background:#e3ece7;color:#1f4034;padding:12px;border-radius:6px}
input[type=date],select{width:100%;font:inherit;padding:12px;border:1px solid var(--rule);border-radius:6px;background:#fff}textarea.body{min-height:50vh;font:16px/1.6 ui-monospace,Menlo,monospace}
button.warn{background:#efe7dc;color:#6b3f12;border:1px solid #6b3f12}button.second{background:transparent;color:var(--accent);border:1px solid var(--accent)}
header>span{display:flex;flex-wrap:wrap;gap:6px 12px;max-width:100%}header>span a{margin-left:0}
${changes.CHANGES_CSS}`;

function ownerPage(title: string, body: Raw, opts: { signedIn?: boolean; script?: string; status?: number; headers?: HeadersInit } = {}): Response {
  const n = nonce();
  const r = respond(
    html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"><meta name="robots" content="noindex"><title>${title}</title><style>${raw(OWNER_CSS)}</style></head><body><div class="wrap">
<header><a href="/" style="margin:0">← Site</a>${opts.signedIn ? html`<span><a href="/review">Review</a><a href="/review/write">Write</a><a href="/review/stats">Stats</a><a href="/review/history">History</a><a href="/review/assistants">Assistants</a><a href="/review/passkeys">Passkeys</a><a href="/review/readers">Readers</a></span>` : ""}</header>
${body}</div>${opts.script ? raw(`<script nonce="${n}">${opts.script}</script>`) : ""}</body></html>`,
    {
      status: opts.status,
      headers: { "Cache-Control": "no-store", "X-Frame-Options": "DENY", ...Object.fromEntries(new Headers(opts.headers)) },
      csp: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; img-src 'self' https:; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'`,
    },
  );
  // Analytics never counts a browser the owner is signed in on.
  if (opts.signedIn) r.headers.append("Set-Cookie", analytics.NOTRACK_SET);
  return r;
}

/** A sign-in's answer also marks the browser as not counted by analytics. */
function signedInJson(cookie: string): Response {
  const r = json({ ok: true, reader: cookie.startsWith(owner.READER_COOKIE + "=") }, 200, { "Set-Cookie": cookie });
  r.headers.append("Set-Cookie", analytics.NOTRACK_SET);
  return r;
}

/** The passkey ceremony: JSON in, JSON out, then go to `next`. */
const PASSKEY_JS = (kind: "setup" | "login" | "add" | "invite" | "recover", next: string, base: string = kind) => `
const form = document.querySelector("form"), err = document.querySelector(".error");
form.addEventListener("submit", async (e) => {
  e.preventDefault(); err.hidden = true;
  const say = (m) => { err.textContent = m; err.hidden = false; };
  try {
    if (!window.PublicKeyCredential || !PublicKeyCredential.parseRequestOptionsFromJSON) return say("This browser can't use passkeys. Try an up-to-date Safari, Chrome or Firefox.");
    const body = Object.fromEntries(new FormData(form));
    const r = await fetch("/${base}/options", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) return say(j.message);
    const cred = ${kind !== "login"
      ? `await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(j.options) })`
      : `await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(j.options) })`};
    const v = await fetch("/${base}/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cred.toJSON()) });
    const k = await v.json(); if (!v.ok) return say(k.message);
    if (k.reader) location.href = "/"; else location.href = ${JSON.stringify(next)};
  } catch (x) { say(x && x.name === "NotAllowedError" ? "Cancelled. Try again when you're ready." : String(x)); }
});`;

const json = (v: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

// Where to go after signing in: one of the owner's own pages, with any query
// (a connect request's carries plain ":" and "/"; its own address must
// survive). A single leading "/" keeps it on this site; only plain URL
// characters (no quotes, angle brackets or backslash: it goes into a script).
function safeNext(next: string | null): string {
  return next && /^\/(review|authorize)([/?][A-Za-z0-9/_?=&%.:~+,;!*()@$-]*)?$/.test(next) ? next : "/review";
}

async function requireOwner(req: Request, env: Env): Promise<Response | null> {
  if (await owner.signedIn(env.DB, req)) return null;
  if (await owner.readerSignedIn(env.DB, req)) return new Response(null,{status:303,headers:{Location:"/"}});
  const u = new URL(req.url);
  if (!(await owner.hasOwner(env.DB))) return Response.redirect(`${u.origin}/setup`, 303);
  return Response.redirect(`${u.origin}/login?next=${encodeURIComponent(u.pathname + u.search)}`, 303);
}

// --- owner: claim, sign in ---------------------------------------------------

// /setup may carry the code in its address (/setup?code=...): never send it on
// as a referrer, never keep it in a cache, and take it out of the address bar.
const SETUP_HEADERS = { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
const SETUP_JS = 'if (location.search) history.replaceState(null, "", location.pathname);\n';

async function setupPage(req: Request, env: Env): Promise<Response> {
  if (await owner.hasOwner(env.DB)) {
    return new Response(null, { status: 303, headers: { ...SETUP_HEADERS, Location: new URL("/login", req.url).href } });
  }
  const code = (new URL(req.url).searchParams.get("code") ?? "").trim().slice(0, 200);
  const intro = code
    ? "Your setup code is filled in. Add your name if you like, then create a passkey."
    : "Enter the setup code you were given, then create a passkey. No code? If the site was installed at get.porchsite.dev/install/, run it again with the same name and token: it keeps everything and gives you a new claim link. Otherwise, ask whoever set it up.";
  return ownerPage(
    "Set up your site",
    html`<h1>Make this site yours</h1><p class="meta">${new URL(req.url).host}</p><p>${intro} From then on, your passkey is the only way to approve what goes live.</p>
<form><label>Setup code</label><input type="password" name="code" autocomplete="off" required${code ? raw(` value="${esc(code)}"`) : ""}><label>Your name (optional: your passkey is saved under it, next to this site's address)</label><input type="text" name="name" autocomplete="name" maxlength="80">
<p class="error" hidden></p><button>Create my passkey</button></form>`,
    // Owner pages are already no-store.
    { script: SETUP_JS + PASSKEY_JS("setup", "/review"), headers: { "Referrer-Policy": SETUP_HEADERS["Referrer-Policy"] } },
  );
}

async function loginPage(req: Request, env: Env): Promise<Response> {
  if (!(await owner.hasOwner(env.DB))) return Response.redirect(new URL("/setup", req.url).href, 303);
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  return ownerPage(
    "Sign in",
    html`<h1>Sign in</h1><p>Use your passkey.</p><form><p class="error" hidden></p><button>Sign in with passkey</button></form>`,
    { script: PASSKEY_JS("login", next) },
  );
}

// --- themes ---------------------------------------------------------------------

const THEME_CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Pages always check back, so an approved change is live for everyone at once;
// a miss is never stored, so a page published a moment later can't hide behind it.
function themedHtml(body: string, status = 200, sources?: unknown, origin = ""): Response {
  return respond(raw(body), { status, headers: { "Cache-Control": status === 404 ? "no-store" : "no-cache", "Permissions-Policy": PERMISSIONS }, csp: frameCsp(THEME_CSP, sources, origin) });
}

/** Public pages through the site's theme, or null for the built-in look. */
async function themedPage(req: Request, env: Env, path: string): Promise<Response | null> {
  const isPublic =
    path === "/" ||
    /^\/(e|static)\//.test(path) ||
    /^\/[a-z][a-z0-9-]{0,29}\/((tags\/[a-z0-9-]{1,30}\/)|search\.json|feed\.xml|[a-z0-9-]{1,80}\/)?$/.test(path);
  if (!isPublic) return null;
  const v = await contentView(req,env);
  const origin = new URL(req.url).origin;
  const policy = {sources: v.site.embed_sources, origin};
  const page = (body: string) => themedHtml(body, 200, policy.sources, origin);
  // Entry addresses before streams had paths: /e/<slug>/ moves to the entry's own.
  const old = /^\/e\/([a-z0-9-]+)\/?$/.exec(path);
  if (old) {
    const moved = v.entries.find((x) => x.slug === old[1]);
    if (moved) return new Response(null, { status: 301, headers: { Location: moved.external_url || moved.page } });
  }
  // Feeds are the site's own, whatever its look.
  const atom = /^\/([a-z][a-z0-9-]{0,29})\/feed\.xml$/.exec(path);
  if (atom) return theme.feed(v, atom[1], origin);
  const name = await themes.load(env.DB, String(v.site.theme));
  if (!name) return null;
  const release = v.updated.replace(/[^0-9A-Za-z]/g, "") || "0";
  const st = /^\/static\/([a-z0-9._-]+)$/.exec(path);
  if (st) return theme.staticFile(name, st[1], String(v.site.palette ?? ""));
  if (path === "/") return page(theme.render(name, "home", theme.homeView(v, release, origin), policy));
  const e = v.entries.find((x) => x.page === path);
  if (e?.external_url) return Response.redirect(e.external_url, 302);
  if (e) return page(theme.render(name, "entry", theme.entryView(v, e, release, origin), policy));
  const search = /^\/([a-z][a-z0-9-]{0,29})\/search\.json$/.exec(path);
  if (search) return theme.searchIndex(v, search[1]);
  const arch = /^\/([a-z][a-z0-9-]{0,29})\/(?:tags\/([a-z0-9-]{1,30})\/)?$/.exec(path);
  if (arch) {
    const av = theme.archiveView(v, arch[1], release, origin, arch[2]);
    if (av) return page(theme.render(name, arch[2] ? "tag" : "archive", av, policy));
  }
  return null;
}

async function contentView(req: Request, env: Env, discovery = false) {
  await privacy.requireContent(env.DB,req);
  return site.liveView(env.DB,discovery);
}

/** The 404 page, in the site's theme when it has one. */
async function notFoundPage(req: Request, env: Env): Promise<Response> {
  const v = await contentView(req,env);
  const u = new URL(req.url);
  const to =
    req.method === "GET"
      ? (site.redirectFor(v, u.pathname) ?? (await content.movedAddress(env.DB, v.entries, v.site.streams, u.pathname)))
      : null;
  // An hour, not forever: a browser keeps a bare 301 for good, and a stream can move again.
  if (to) return new Response(null, { status: 301, headers: { Location: to + u.search, "Cache-Control": "max-age=3600" } });
  const name = await themes.load(env.DB, String(v.site.theme));
  if (!name) return site.notFound(v, u.origin);
  const release = v.updated.replace(/[^0-9A-Za-z]/g, "") || "0";
  return themedHtml(theme.render(name, "not_found", theme.notFoundView(v, release, u.origin), {sources:v.site.embed_sources,origin:u.origin}), 404, v.site.embed_sources, u.origin);
}

// --- the person's phone: a one-time photo upload ----------------------------------

async function uploadPage(env: Env, req: Request, token: string): Promise<Response> {
  const shut = () =>
    ownerPage("Link used", html`<h1>This link has been used or has expired</h1><p>Ask your assistant for a new one.</p>`, { status: 410 });
  if (req.method === "POST") {
    // An assistant sending the file itself asks for JSON and gets the result
    // in the answer; the person's browser gets a page.
    const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
    const form = await req.formData().catch(() => null);
    const file = form?.get("photo");
    try {
      if ((form?.getAll("photo").length ?? 0) !== 1 || [...(form?.values() ?? [])].filter((v) => v instanceof File).length !== 1) throw new ApiError(422, "invalid", "Choose exactly one photo.");
      const done = await uploads.receive(env.DB, token, file instanceof File ? file : null, String(form?.get("alt") ?? ""));
      if (wantsJson) return json(done);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (wantsJson) return json(e.toJSON(), e.status);
      if (e.code === "link_used") return shut();
      const u = await uploads.open(env.DB, token);
      return u ? uploadForm(u, e.message) : shut();
    }
    return ownerPage("Sent", html`<h1>Got it, thank you</h1><p>Your assistant can use the photo now. Nothing shows on your site until you approve it.</p>`);
  }
  const u = await uploads.open(env.DB, token);
  return u ? uploadForm(u, "") : shut();
}

function uploadForm(u: uploads.Upload, error: string): Response {
  return ownerPage(
    "Add a photo",
    html`<h1>Add a photo</h1>${u.purpose ? html`<p>For: ${u.purpose}</p>` : ""}${error ? html`<p class="error">${error}</p>` : ""}
<form method="post" enctype="multipart/form-data"><label>Photo</label><input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required>
<label>What it shows, in a few words (for people who can't see it)</label><input type="text" name="alt" maxlength="200" required>
<label><input type="checkbox" name="original" style="width:auto"> Keep the original size</label>
<p class="meta">Bigger files use more of the free plan's limits, make pages slower and take more storage.</p>
<p class="meta">By default, this browser makes a web-size JPEG, at most 2400 pixels on the long side. If it cannot resize the picture, the original file is sent instead.</p>
<button>Upload</button></form><p class="meta">This link works once and stops at ${u.expires_at.slice(11, 16)} UTC.</p>`,
    { script: uploads.SHRINK_JS },
  );
}

// --- owner: review -------------------------------------------------------------

function unsentLine(n: number): Raw | string {
  if (!n) return "";
  const what = n === 1 ? "There is 1 change" : `There are ${n} changes`;
  return html`<p class="meta">${what} not yet sent to you for review. Nothing goes live until you approve it.</p>`;
}

async function importPage(req: Request, error = "", problems: string[] = []): Promise<Response> {
  return ownerPage(
    "Import",
    html`<h1>Import from an assistant</h1><p>For an assistant that can't reach your site: it gives you one file, and you upload it here. Everything in it is checked like any draft and waits for your approval; nothing goes live from here.</p>${error ? html`<p class="error">${error}</p>` : ""}${problems.length ? html`<ul class="meta">${problems.map((p) => html`<li>${p}</li>`)}</ul>` : ""}
<form method="post" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${await owner.csrf(req)}"><label>The file (.json)</label><input type="file" name="file" accept=".json,application/json" required><button>Import and review</button></form>`,
    { signedIn: true, status: error ? 422 : 200 },
  );
}

async function reviewIndex(env: Env, req: Request): Promise<Response> {
  await alerts.opened(env.DB,req);
  const devices=await alerts.devices(env.DB), device=devices.find(d=>d.id===alerts.cookie(req));
  const all = await approvals.list(env.DB);
  const open = all.filter((a) => a.items.some((i) => i.status === "pending"));
  const done = all.filter((a) => !a.items.some((i) => i.status === "pending")).slice(0, 20);
  const row = (a: approvals.Approval) =>
    html`<a class="card" href="/review/${a.id}"><div class="meta">${a.requested_by} · ${a.created_at.slice(0, 16).replace("T", " ")} UTC</div>${a.items.map(
      (i) => html`<h2>${i.label}</h2><div class="meta">${i.kind} · ${i.change} · ${i.status.replace("_", " ")}</div>`,
    )}<span class="go">${a.items.some((i) => i.status === "pending") ? "Review and decide →" : "See details →"}</span></a>`;
  return ownerPage(
    "Review",
    html`${raw(update.noticeHtml(await update.check(env.OAUTH_KV), esc))}<h1>Waiting for you</h1>${alertControls(await owner.csrf(req),device?.id??"",device?.fingerprint??"")}${unsentLine(await approvals.unsent(env.DB))}${open.length ? open.map(row) : html`<p class="meta">Nothing is waiting.</p>`}
<h1 style="margin-top:36px">Decided</h1>${done.length ? done.map(row) : html`<p class="meta">Nothing yet.</p>`}
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${await owner.csrf(req)}"><button class="ghost">Sign out</button></form>
<p class="meta" style="margin-top:32px">An assistant gave you a file? <a href="/review/import">Import it</a>.</p>
<div id="share-cards" hidden data-csrf="${await owner.csrf(req)}"></div>`,
    { signedIn: true, script: sharecards.CARD_JS+"\n"+ALERT_JS },
  );
}

const KIND_WORD: Record<string, string> = { site: "your site's text and look", entry: "page", card: "card", note: "note" };

/** The review and revert pages: a decision says it's working, and can't be sent twice. */
export const BUSY_JS = `// A big decision can take seconds: say so, and stop a second press.
document.querySelectorAll("form").forEach(function (f) {
  f.addEventListener("submit", function (e) {
    var b = e.submitter, msg = b && b.getAttribute("data-busy");
    setTimeout(function () { f.querySelectorAll("button").forEach(function (x) { x.disabled = true; }); }, 0);
    if (msg) { var p = document.createElement("p"); p.className = "meta busy"; p.setAttribute("role", "status"); p.textContent = msg; b.insertAdjacentElement("afterend", p); }
  });
});
window.addEventListener("pageshow", function () {
  document.querySelectorAll("form button").forEach(function (x) { x.disabled = false; });
  document.querySelectorAll(".busy").forEach(function (p) { p.remove(); });
});
`;

const busyWord = (n: number, what: string) => `${what} ${n} change${n === 1 ? "" : "s"}… This can take a few seconds; keep this page open.`;

async function reviewShow(env: Env, req: Request, id: string, error = ""): Promise<Response> {
  const a = await approvals.get(env.DB, id);
  const blocks: Raw[] = [];
  const embedChanges: {id:string;kind:string;data:Record<string,any>;deleted:boolean}[] = [];
  // The whole request in three queries, however many items it has.
  const ids = a.items.map((it) => it.id);
  const items = await content.itemsByIds(env.DB, ids);
  const lives = await content.liveByIds(env.DB, ids);
  const revs = await content.revisionsAt(env.DB, a.items);
  let streamsLive: { id: string; path: string }[] | undefined;
  for (const it of a.items) {
    const item = items.get(it.id);
    if (!item) throw new ApiError(404, "not_found", `No item ${it.id}.`);
    const live = lives.get(it.id);
    const rev = revs.get(`${it.id}@${it.version}`);
    const shown = rev ? JSON.parse(rev.data) : item.data;
    if (it.status === "pending") embedChanges.push({id: it.id, kind: it.kind, data: shown, deleted: !!rev?.deleted});
    // An entry whose address changes says so: the old one will send visitors on.
    const moves: Raw[] = [];
    if (it.kind === "entry" && it.change === "changed" && live?.slug && item.slug) {
      streamsLive ??= (await content.siteData(env.DB, true)).streams as { id: string; path: string }[];
      const streams = streamsLive;
      const pageOf = (stream: unknown, slug: string) => {
        const s = streams.find((x) => x.id === stream) ?? streams[0];
        return `/${s.path || s.id}/${slug}/`;
      };
      const from = pageOf(JSON.parse(live.data).stream, live.slug);
      const to = pageOf(shown.stream, item.slug);
      if (from !== to) moves.push(changes.addressRow(from, to));
    }
    const what = it.kind === "site" ? (it.change === "new" ? "Your site's text and look" : "Changes to your site's text and look") : `${it.change === "new" ? "New" : it.change === "removed" ? "Removing the" : "Changed"} ${KIND_WORD[it.kind] ?? it.kind}: ${it.label}`;
    const status = it.status === "pending" ? "" : html`<span class="tag">${it.status.replace("_", " ")}</span>`;
    blocks.push(html`<div class="card">${status}<h2 style="margin-top:4px">${what}</h2>
${it.change === "removed" ? changes.takenOff(it.label) : live ? changes.whatChanged(it.kind, shown, JSON.parse(live.data), moves) : changes.whatItSays(it.kind, shown, it.kind !== "site")}
${it.note ? html`<p class="meta">Your note: ${it.note}</p>` : ""}
${it.status === "published" && it.change !== "removed" ? html`<p><a href="${item.kind === "entry" && item.slug ? `/e/${item.slug}/` : "/"}">See it on the site →</a></p>` : ""}
${it.status === "pending"
  ? html`<details class="one"><summary class="meta" style="cursor:pointer">Decide this one separately</summary><fieldset class="choice" style="border:0;padding:0;margin-top:10px"><label><input type="radio" name="d_${it.id}" value="approve" checked> Publish it</label>
<label><input type="radio" name="d_${it.id}" value="changes"> Ask for changes</label><label><input type="radio" name="d_${it.id}" value="deny"> No, leave it out</label>
<label><input type="radio" name="d_${it.id}" value="later"> Decide later</label></fieldset><label>Note to your assistant (optional)</label><textarea name="n_${it.id}" rows="2"></textarea></details>`
  : ""}</div>`);
  }
  const pending = a.items.some((i) => i.status === "pending");
  const who = a.requested_by.replace(/^assistant:/, "") || "Your assistant";
  const count = a.items.filter((i) => i.status === "pending").length;
  const waiting = a.items.filter((i) => i.status === "pending");
  const n = (c: string) => waiting.filter((i) => i.change === c).length;
  const parts = [n("new") && `add ${n("new")}`, n("changed") && `change ${n("changed")}`, n("removed") && `remove ${n("removed")}`].filter(Boolean);
  const sentence = parts.length ? `${who} wants to ${parts.join(", ").replace(/, ([^,]*)$/, " and $1")} thing${count === 1 ? "" : "s"} on your site.` : "";
  const raised = await visibility.raises(env.DB, waiting);
  return ownerPage(
    "Review changes",
    html`${raw(update.noticeHtml(await update.check(env.OAUTH_KV), esc))}<h1>${pending ? html`${who} has ${count} change${count === 1 ? "" : "s"} for your site` : "Decided"}</h1>${a.note ? html`<p>${a.note}</p>` : ""}${error ? html`<p class="error">${error}</p>` : ""}
${raw(await embedReviewFor(env.DB, embedChanges, new URL(req.url).origin))}${raw(await privateReviewWarning(env.DB,embedChanges))}
${raised.map((r) => html`<p class="warn">${raiseLine(r)}</p>`)}
${pending ? html`<p>${sentence} Nothing changes until you approve. Look first:</p><p><a class="button" href="/review/${a.id}/preview">See the site as it will look</a></p>` : ""}
<form method="post"><input type="hidden" name="csrf" value="${await owner.csrf(req)}">
${pending ? html`<button name="all" value="approve" data-busy="${busyWord(count, "Publishing")}">Approve and publish</button>
<details id="changes" style="margin-top:12px"><summary class="meta" style="cursor:pointer">Ask for changes instead</summary><label>What should your assistant change?</label><textarea name="note_all" rows="3"></textarea><button class="ghost" name="all" value="changes" data-busy="Sending your note to your assistant…">Send back for changes</button></details>
<h2 style="margin-top:28px">What's in it</h2>` : ""}${blocks}${pending ? html`<button class="ghost" name="all" value="each" data-busy="Saving your choices…">Save my separate choices</button>` : ""}</form>`,
    { signedIn: true, script: BUSY_JS },
  );
}

const VIS_WORD: Record<string, string> = { private: "private (not shown)", mention: "a mention (name and description only)", public: "public (the whole card)" };

/** A card this change shows more of than the live site does. */
function raiseLine(r: visibility.Raise): string {
  return `Shows more: the card "${r.name}" goes from ${VIS_WORD[r.from] ?? r.from} to ${VIS_WORD[r.to] ?? r.to}.`;
}

async function reviewDecide(env: Env, req: Request, id: string): Promise<Response> {
  const form = await req.formData();
  if (form.get("csrf") !== (await owner.csrf(req))) return reviewShow(env, req, id, "This form expired. Try again.");
  const decisions: Record<string, { decision: approvals.Decision; note: string }> = {};
  const all = String(form.get("all") ?? "each");
  if (all === "approve" || all === "changes") {
    // One answer for everything waiting: the big buttons.
    const note = String(form.get("note_all") ?? "");
    if (all === "changes" && !note.trim()) return reviewShow(env, req, id, "Say what should change, so your assistant knows what to do.");
    for (const i of (await approvals.get(env.DB, id)).items) if (i.status === "pending") decisions[i.id] = { decision: all as approvals.Decision, note };
  } else {
    for (const [k, v] of form.entries()) {
      if (k.startsWith("d_")) {
        const itemId = k.slice(2);
        decisions[itemId] = { decision: String(v) as approvals.Decision, note: String(form.get(`n_${itemId}`) ?? "") };
      }
    }
  }
  try {
    await approvals.decide(env.DB, id, decisions, "", new URL(req.url).origin);
  } catch (e) {
    if (e instanceof ApiError) return reviewShow(env, req, id, e.message);
    throw e;
  }
  const origin = new URL(req.url).origin;
  if (all === "approve") {
    return ownerPage(
      "Live",
      html`<h1>Your site is updated</h1><p>The changes are live now at <a href="/">${origin.replace(/^https:\/\//, "")}</a>.</p><p><a class="button" href="/">See your site</a></p><p><a href="/review">Back to your reviews</a></p><div id="share-cards" hidden data-csrf="${await owner.csrf(req)}"></div>`,
      { signedIn: true, script: sharecards.CARD_JS },
    );
  }
  if (all === "changes") {
    return ownerPage("Sent back", html`<h1>Your assistant has been told</h1><p>Nothing changed on your site. Your assistant will see your note and send you the changes to look at again.</p><p><a href="/review">Back to your reviews</a></p>`, { signedIn: true });
  }
  return Response.redirect(new URL(`/review/${id}`, req.url).href, 303);
}

// --- connecting an assistant (OAuth consent) ---------------------------------

function oauthError(error: unknown, status = 400): Response {
  if (error instanceof AuthorizationError && error.redirectUri) {
    const r = new URL(error.redirectUri);
    r.searchParams.set("error", error.code);
    r.searchParams.set("error_description", error.description);
    if (error.state) r.searchParams.set("state", error.state);
    if (error.issuer) r.searchParams.set("iss", error.issuer);
    return Response.redirect(r.href, 302);
  }
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
    return ownerPage("Can't connect", html`<h1>Can't connect</h1><p>${message}</p>`, { status });
  }
  throw error;
}

async function authorizeGet(env: Env, req: Request): Promise<Response> {
  // Connecting before the claim would leave the app with a broken connector:
  // say so, rather than sending them to the setup form.
  if (!(await owner.hasOwner(env.DB))) {
    return ownerPage("Not claimed yet", html`<h1>Not claimed yet</h1><p>This site hasn't been claimed by its owner yet, so no assistant can connect to it. Claim it first, with the claim link from the installer (or the setup link your assistant gave you). Then connect again: remove this connector and add it anew, so your app picks up the site's tools.</p>`, { status: 409 });
  }
  const gate = await requireOwner(req, env);
  if (gate) return gate;
  try {
    const oauth = env.OAUTH_PROVIDER;
    const ar = await oauth.parseAuthRequest(req);
    // PKCE from every app, confidential ones too (the library lets those skip it).
    if (!ar.codeChallenge) {
      throw new AuthorizationError("invalid_request", {
        description: "Clients must use PKCE (S256) with the authorization code flow.",
        redirectUri: ar.redirectUri,
        state: ar.state || undefined,
        issuer: ar.issuer,
      });
    }
    const client = await oauth.lookupClient(ar.clientId);
    if (!client) return ownerPage("Can't connect", html`<h1>Unknown app</h1>`, { status: 400 });
    const consent = await oauth.beginConsent(ar);
    const name = client.clientName ?? client.clientId;
    const host = new URL(ar.redirectUri).hostname;
    const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(host);
    const verified = client.clientId.startsWith("https://")
      ? html`Published by <strong>${new URL(client.clientId).hostname}</strong>.`
      : html`This app named itself; the name isn't verified.`;
    const page = ownerPage(
      "Connect an assistant",
      html`<h1>Let ${name} work on your site?</h1><p>${verified} Access goes to <strong>${host}</strong>.</p>
${local ? html`<p class="error">This sends access to an app on a computer. Continue only if you just started connecting from it.</p>` : ""}
<div class="card"><p style="margin:0">It will be able to <b>read your site and draft changes</b>. It <b>can't publish</b>: every change waits for you here.</p></div>
<form method="post"><input type="hidden" name="handle" value="${consent.handle}">
<label>Call it</label><input type="text" name="label" value="${name}" maxlength="40" autocomplete="off">
<p class="meta">This is the name you'll see on its requests. Apps sometimes register under their vendor's name.</p>
<button name="decision" value="approve">Allow</button>
<button class="ghost" name="decision" value="deny">Don't allow</button></form>`,
      { signedIn: true, headers: consent.headers },
    );
    return page;
  } catch (e) {
    return oauthError(e);
  }
}

async function authorizePost(env: Env, req: Request): Promise<Response> {
  const gate = await requireOwner(req, env);
  if (gate) return gate;
  try {
    const oauth = env.OAUTH_PROVIDER;
    const form = await req.clone().formData();
    const handle = String(form.get("handle") ?? "");
    // Some in-app sheets drop the consent cookie on POST. The owner session
    // already binds this browser: consent GET and POST both require it, and
    // SameSite=Lax excludes it from cross-site POSTs. Only the owner can mint
    // handles; another valid handle they minted need not be the displayed one.
    // Keep present cookies (even wrong ones) and all library handle/TTL/use checks.
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(handle))),b=>b.toString(16).padStart(2,"0")).join("");
    const bindingName = `__Host-oauth-consent-${hash.slice(0,16)}`;
    let consentReq = req;
    if (cookieValue(req,bindingName) === null) {
      const headers = new Headers(req.headers);
      headers.set("Cookie",[headers.get("Cookie"),`${bindingName}=${hash}`].filter(Boolean).join("; "));
      consentReq = new Request(req,{headers});
    }

    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(consentReq, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(consentReq, handle);
    const client = await oauth.lookupClient(approved.request.clientId);
    const label = String(form.get("label") ?? "").trim().slice(0, 40);
    const name = (label || client?.clientName || approved.request.clientId).slice(0, 80);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: { client: name },
      scope: approved.request.scope,
      props: { client: name, clientId: approved.request.clientId, origin: new URL(req.url).origin },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    return oauthError(e);
  }
}

async function assistantsPage(env: Env, req: Request, revoke?: string, made?: { name: string; token: string; expires_at: string }): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (revoke) await oauth.revokeGrant(revoke, "owner");
  const { items } = await oauth.listUserGrants("owner");
  const token = await owner.csrf(req);
  const mcpUrl = new URL("/mcp", req.url).href;
  const keyList = await keys.list(env.DB);
  return ownerPage(
    "Assistants",
    html`<h1>Connected assistants</h1><p>Each can read your site and draft changes. None can publish.</p>${
      items.length
        ? items.map(
            (g) =>
              html`<div class="card"><h2>${(g.metadata as { client?: string })?.client ?? g.clientId}</h2><div class="meta">since ${new Date(g.createdAt * 1000).toISOString().slice(0, 10)}</div>
<form method="post"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="revoke" value="${g.id}"><button class="ghost">Disconnect</button></form></div>`,
          )
        : html`<p class="meta">None yet. In your assistant, add a connector with this address: <b>${mcpUrl}</b></p>`
    }
<h1 style="margin-top:36px">Assistant keys</h1>
<p>For an assistant whose app can't add a connector with sign-in. Make a key, then put it in the assistant's secret or API-key field, never in a chat. It reaches the same tools at <b>${mcpUrl}</b> as <code>Authorization: Bearer</code> and the key. Like any assistant, it can only draft: everything waits for you here. A key stops working after ${String(keys.KEY_DAYS)} days, or when you revoke it.</p>
${made ? html`<div class="card"><h2>Key for ${made.name}</h2><p class="value"><b>${made.token}</b></p><p>Put it in your assistant's app, in its field for secrets, API keys or connector credentials. <b>Never paste it into a chat</b>, even if your assistant asks: anyone who reads the chat could use it. If you did, revoke it below and make a new one.</p><p class="meta">Copy it now: it isn't shown again. Works until ${made.expires_at.slice(0, 10)}.</p></div>` : ""}
${keyList.map(
  (k) =>
    html`<div class="card"><h2>${k.name}</h2><div class="meta">made ${k.created_at.slice(0, 10)} · works until ${k.expires_at.slice(0, 10)} · ${k.last_used_at ? `last used ${k.last_used_at.slice(0, 10)}` : "not used yet"}</div>
<form method="post"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="revoke_key" value="${k.id}"><button class="ghost">Revoke</button></form></div>`,
)}
<form method="post"><input type="hidden" name="csrf" value="${token}"><label>Which assistant is it for?</label><input type="text" name="key_name" maxlength="40" required placeholder="e.g. Muse"><button name="make_key" value="1">Make a key</button></form>`,
    { signedIn: true },
  );
}

// --- owner: the site as it will look ------------------------------------------------

/** One page of the site as it will look in the theme it would have, or null if it has no such page. */
function previewBody(t: themes.Theme | null, v: site.SiteView, path: string, origin: string): Promise<string> | string | null {
  if (path === "/") return t ? theme.render(t, "home", theme.homeView(v, "preview", origin)) : site.home(v).text();
  const e = v.entries.find((x) => x.page === path && !x.external_url);
  if (e) return t ? theme.render(t, "entry", theme.entryView(v, e, "preview", origin)) : (site.entryPage(v, e.page)?.text() ?? null);
  const arch = /^\/([a-z][a-z0-9-]{0,29})\/(?:tags\/([a-z0-9-]{1,30})\/)?$/.exec(path);
  const av = t && arch ? theme.archiveView(v, arch[1], "preview", origin, arch[2]) : null;
  return av ? theme.render(t!, arch![2] ? "tag" : "archive", av) : null;
}

/**
 * The site with this approval's items published on top of what's live, in the
 * theme it would have: every page, with its links kept inside the preview.
 */
async function reviewPreview(env: Env, req: Request, id: string, path = "/"): Promise<Response> {
  const a = await approvals.get(env.DB, id);
  const v = await site.proposedView(env.DB, a.items.filter((i) => i.status === "pending" || i.status === "published").map((i) => ({ id: i.id, version: i.version })));
  const t = await themes.load(env.DB, String(v.site.theme));
  const origin = new URL(req.url).origin;
  const page = await previewBody(t, v, path, origin);
  if (page === null) return await notFoundPage(req, env);
  const base = `/review/${a.id}/preview`;
  const body = (await inlineCss(t, v, page)).replace(/(href=")\/(?!\/|static\/|media\/|review\/)([^"]*")/g, `$1${base}/$2`);
  const pending = a.items.some((i) => i.status === "pending");
  const raised = await visibility.raises(env.DB, a.items.filter((i) => i.status === "pending"));
  const csrf = await owner.csrf(req);
  const btn = "font:600 15px/1 -apple-system,sans-serif;border-radius:6px;padding:12px 16px;border:0;cursor:pointer";
  // A bar across the top says what this is, with the decision right there; nothing here is public.
  const bar = `<div style="position:sticky;top:0;z-index:99;background:#1c1f1d;color:#fff;font:15px/1.4 -apple-system,sans-serif;padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
<span>Preview: nothing is live yet.</span>${raised.map((r) => `<span style="flex-basis:100%;color:#f3d9a4">${esc(raiseLine(r))}</span>`).join("")}<span style="display:flex;gap:8px;flex-wrap:wrap">
<a style="${btn};background:#fff;color:#1c1f1d;text-decoration:none" href="/review/${a.id}">Back</a>${
    pending
      ? `<a style="${btn};background:transparent;color:#fff;border:1px solid #fff;text-decoration:none" href="/review/${a.id}#changes">Ask for changes</a><form method="post" action="/review/${a.id}" style="margin:0"><input type="hidden" name="csrf" value="${csrf}"><button name="all" value="approve" style="${btn};background:#9fd8c4;color:#1c1f1d">Approve and publish</button></form>`
      : ""
  }</span></div>`;
  const html = body.replace(/<body([^>]*)>/, `<body$1>${bar}`);
  return respond(raw(html), {
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    csp: THEME_CSP.replace("form-action 'none'", "form-action 'self'"),
  });
}

/**
 * The proposed theme's stylesheet and palette go inline: /static/ serves the
 * LIVE theme, which before a first approval (or a theme switch) isn't this one.
 */
async function inlineCss(t: themes.Theme | null, v: site.SiteView, body: string): Promise<string> {
  if (!t) return body;
  const css = await theme.staticFile(t, "site.css", String(v.site.palette ?? ""))!.text();
  return body.replace(/<link rel="stylesheet" href="\/static\/site\.css[^"]*">/, () => `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`);
}

// --- owner: more passkeys -----------------------------------------------------------

async function passkeysPage(env: Env, req: Request, made?: { token: string; expires_at: string }): Promise<Response> {
  const n = await owner.passkeyCount(env.DB);
  const here = new URL(req.url).origin;
  return ownerPage(
    "Passkeys",
    html`<h1>Passkeys</h1><p>You have ${n} passkey${n === 1 ? "" : "s"} for this site. A passkey works only on the device and the address where it was made, so add one for each phone or computer you approve from, and again if the site moves to a new address.</p>
${
  made
    ? html`<div class="card"><h2>Your link</h2><p>Open it on the device, or at the address, where you want the new passkey. Swap the start of the link for the new address if the site is moving (for example <b>https://example.com</b>). It works once, until ${made.expires_at.slice(11, 16)} UTC.</p><p class="value"><b>${here}/passkey/${made.token}</b></p></div>`
    : html`<form method="post"><input type="hidden" name="csrf" value="${await owner.csrf(req)}"><button>Make a link to add a passkey</button></form>`
}`,
    { signedIn: true },
  );
}

async function addPasskeyPage(env: Env, token: string): Promise<Response> {
  if (!(await owner.passkeyLinkOpen(env.DB, token))) {
    return ownerPage("Link used", html`<h1>This link has been used or has expired</h1><p>Make a new one on the Passkeys page where you're signed in.</p>`, { status: 410 });
  }
  return ownerPage(
    "Add a passkey",
    html`<h1>Add a passkey here</h1><p>This saves a new passkey for this site on this device, at this address. Your other passkeys keep working.</p>
<form><p class="error" hidden></p><button>Create my passkey</button></form>`,
    { script: PASSKEY_JS("add", "/review", `passkey/${token}`) },
  );
}


// --- owner: who reads the site ------------------------------------------------------

const RANGES: [string, string][] = [["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]];
const SOURCE_WORD: Record<string, string> = { x: "X", search: "Search", direct: "Direct or app", other: "Other sites", internal: "Inside the site" };
const PAGE_WORD: Record<string, string> = { home: "Home page", archive: "Archive", tag: "Tag page", notfound: "Page not found" };

/** Halves up, as the page shows a share. */
const whole = (x: number) => Math.floor(x + 0.5);
const pad2 = (n: number) => String(n).padStart(2, "0");

/** 1m 05s, 2h 03m. */
export function duration(ms: number): string {
  const s = Math.floor((ms + 500) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
}

const STATS_CSS = `.ranges{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 6px}.range{padding:8px 12px;border:1px solid var(--rule);border-radius:999px;text-decoration:none;font-size:15px;color:var(--accent)}
.range.on{background:var(--accent);color:#fff;border-color:var(--accent)}h2.sub{margin:32px 0 0}.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0}
@media(min-width:560px){.stats{grid-template-columns:repeat(4,minmax(0,1fr))}}.stat{background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:2px}
.stat b{font:500 24px/1.2 ui-monospace,Menlo,monospace}.stat span{font-size:13px;color:var(--muted)}.kv{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px;color:var(--muted);margin:8px 0 12px}
.bar-row{display:grid;grid-template-columns:48px 1fr 36px;gap:8px;align-items:center;font:13px ui-monospace,Menlo,monospace;margin:4px 0}.bar{background:var(--bg);border-radius:3px;height:12px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--accent)}.bar-num{text-align:right}.drop{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.drop-step{display:flex;flex-direction:column;align-items:center;gap:4px;font:12px ui-monospace,Menlo,monospace;color:var(--muted)}.drop-bar{width:100%;height:56px;background:var(--bg);border-radius:4px;display:flex;align-items:flex-end;overflow:hidden}
.drop-bar span{display:block;width:100%;background:var(--accent)}.drop-num{color:var(--ink)}.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--rule);overflow-wrap:anywhere}
.row:last-child{border-bottom:0}.sub-row{font-size:14px;color:var(--muted);padding-left:12px}`;

async function statsPage(env: Env, req: Request): Promise<Response> {
  const asked = new URL(req.url).searchParams.get("days") ?? "7";
  const days = RANGES.some(([k]) => k === asked) ? asked : "7";
  const s = (await analytics.stats(env.DB, { days: Number(days) })) as any;
  const t = s.totals;
  const peak = Math.max(0, ...s.daily.map((d: any) => d.visits));
  const tile = (value: string, label: string) => html`<div class="stat"><b>${value}</b><span>${label}</span></div>`;
  return ownerPage(
    "Stats",
    html`<h1>Who's reading</h1>
<div class="ranges">${RANGES.map(([k, label]) => html`<a class="range${k === days ? " on" : ""}" href="/review/stats?days=${k}">${label}</a>`)}</div>
<p class="meta">${s.range.start} to ${s.range.end} · you, bots and test runs aren't counted</p>
<p class="meta">Time on page and scroll can lag up to a minute while someone is still reading. Browser or connection delays can make that longer. If the final message is lost, recorded time and scroll can be lower.</p>
<div class="stats">${tile(String(t.visits), "visitors")}${tile(String(t.views), "pages read")}${tile(duration(t.median_visit_engaged_ms), "typical stay")}${tile(`${whole(t.bounce_rate)}%`, "left right away")}</div>
${t.visits ? html`<p class="meta">${whole(t.multi_page_rate)}% read more than one page. A visitor is one person on one day.</p>` : ""}
${s.daily.length > 1
  ? html`<h2 class="sub">By day</h2><div class="card">${s.daily.map(
      (d: any) => html`<div class="bar-row"><span class="bar-label">${d.day.slice(5)}</span><span class="bar"><span style="width:${peak ? whole((100 * d.visits) / peak) : 0}%"></span></span><span class="bar-num">${d.visits}</span></div>`,
    )}</div>`
  : ""}
<h2 class="sub">What they read</h2>
${s.pages.length
  ? s.pages.map(
      (p: any) => html`<div class="card"><div class="meta">${p.kind} · ${p.path}</div><h2>${p.title || PAGE_WORD[p.kind] || p.path}</h2>
<div class="kv"><span>${p.readers} reader${p.readers === 1 ? "" : "s"}</span><span>typical ${duration(p.median_engaged_ms)}</span><span>avg ${duration(p.mean_engaged_ms)}</span>${p.bounce_rate === null ? "" : html`<span>${whole(p.bounce_rate)}% left right away</span>`}</div>
<div class="drop">${["25", "50", "75", "100"].map(
        (k) => html`<div class="drop-step"><span class="drop-bar"><span style="height:${whole(p.reached[k])}%"></span></span><span class="drop-label">${k}%</span><span class="drop-num">${whole(p.reached[k])}%</span></div>`,
      )}</div>
<p class="meta">Share of readers who got that far down the page. ${p.exits} left the site from here.</p></div>`,
    )
  : html`<p class="meta">No visitors yet in this range.</p>`}
${s.sources.length
  ? html`<h2 class="sub">Where they came from</h2><div class="card">${s.sources.map(
      (r: any) => html`<div class="row"><span>${SOURCE_WORD[r.source] ?? r.source}</span><span>${r.visits} · ${duration(r.engaged_ms)}</span></div>`,
    )}${s.referring_domains.map((d: any) => html`<div class="row sub-row"><span>${d.domain}</span><span>${d.visits}</span></div>`)}</div>`
  : ""}
${s.tagged.length
  ? html`<h2 class="sub">Tagged links</h2><div class="card">${s.tagged.map(
      (r: any) => html`<div class="row"><span>${r.src}${r.post ? ` · ${r.post}` : ""}</span><span>${r.visits} · ${duration(r.visit_engaged_ms)}</span></div>`,
    )}</div>`
  : ""}
${s.earlier.length
  ? html`<h2 class="sub">Earlier, counts only</h2><div class="card">${s.earlier.map(
      (r: any) => html`<div class="row"><span>${r.month}</span><span>${r.visits} visits · ${r.views} views</span></div>`,
    )}</div><p class="meta">Past 90 days only the totals are kept.</p>`
  : ""}
<p class="meta" style="margin-top:32px">This browser isn't counted because you're signed in. To leave another device out without signing in, open any page of the site with <code>?sk_notrack=1</code> on the end.</p>
<style>${raw(STATS_CSS)}</style>`,
    { signedIn: true },
  );
}

// --- owner: the writing desk ------------------------------------------------------------

type DeskValues = Record<(typeof desk.FIELDS)[number], string>;

function valuesOf(item: content.Item): DeskValues {
  const d = item.data as Record<string, any>;
  return {
    stream: String(d.stream ?? ""),
    title: String(d.title ?? ""),
    summary: String(d.summary ?? ""),
    date: String(d.date ?? ""),
    tags: ((d.tags ?? []) as string[]).join(" "),
    cover: String(d.cover ?? ""),
    cover_alt: String(d.cover_alt ?? ""),
    body: String(d.body ?? ""),
  };
}

function deskError(e: ApiError): string {
  if (e.code === "version_conflict" || e.code === "item_changed") {
    return "This entry changed since you opened it (your assistant may have edited it). Copy your text, reload, and redo the change.";
  }
  const problems = (e.extra.problems ?? []) as { field: string; problem: string }[];
  const detail = problems.map((p) => `${p.field || "entry"}: ${p.problem}`).join("; ");
  return `${e.message} ${detail}`.trim();
}

async function writeIndex(env: Env, req: Request): Promise<Response> {
  const published = new URL(req.url).searchParams.get("published") ?? "";
  const list = await desk.entries(env.DB);
  const streams = (await content.siteData(env.DB, false)).streams as { id: string; title: string }[];
  const streamTitle = (id: string) => (streams.find((x) => x.id === id) ?? streams[0])?.title ?? "";
  return ownerPage(
    "Writing",
    html`<h1>Writing</h1><p class="meta">Every entry on your site, newest first. Your assistant's drafts show up here too: finish one and publish it yourself.</p>
${published ? html`<p class="ok">Published. It's live on the site.</p>` : ""}
<p><a class="button" href="/review/write/new">Write something new</a></p>
${list.length
  ? list.map(
      (e) => html`<a class="card" href="/review/write/${e.id}"><span class="tag">${e.state}</span><h2 style="margin-top:8px">${String(e.data.title)}</h2><div class="meta">${String(e.data.date)} · ${streamTitle(String(e.data.stream ?? ""))}${((e.data.tags ?? []) as string[]).map((t) => ` #${t}`).join("")}</div></a>`,
    )
  : html`<p class="meta">Nothing yet.</p>`}`,
    { signedIn: true },
  );
}

async function writeForm(env: Env, req: Request, item: desk.DeskEntry | null, v: DeskValues, opts: { error?: string; saved?: boolean; status?: number } = {}): Promise<Response> {
  const streams = (await content.siteData(env.DB, false)).streams as { id: string; title: string }[];
  const chosen = v.stream || streams[0].id;
  const isLive = item ? item.state === "live" || item.state === "live, edited since" : false;
  const page = isLive ? (await contentView(req,env)).entries.find((x) => x.id === item!.id)?.url : undefined;
  return ownerPage(
    item ? "Edit" : "Write",
    html`<h1>${item ? "Edit" : "Write something new"}</h1>
${item ? html`<p><span class="tag">${item.state}</span>${page ? html` <a href="${page}">See it on the site</a>` : ""}</p>` : ""}
${opts.error ? html`<p class="error">${opts.error}</p>` : ""}${opts.saved ? html`<p class="ok">Saved.${item && item.state !== "draft" && item.state !== "live" ? " Not live until you publish." : ""}</p>` : ""}
<form method="post" action="/review/write/${item ? item.id : "new"}"><input type="hidden" name="csrf" value="${await owner.csrf(req)}"><input type="hidden" name="version" value="${item ? String(item.version) : ""}">
<label for="stream">Where it goes</label><select id="stream" name="stream">${streams.map((x) => html`<option value="${x.id}"${raw(x.id === chosen ? " selected" : "")}>${x.title}</option>`)}</select>
<label for="title">Title</label><input type="text" id="title" name="title" value="${v.title}" maxlength="160" required>
<label for="summary">One or two sentences, shown in lists</label><input type="text" id="summary" name="summary" value="${v.summary}" maxlength="600">
<label for="date">Date</label><input type="date" id="date" name="date" value="${v.date}" required>
<label for="tags">Tags (separate with spaces or commas)</label><input type="text" id="tags" name="tags" value="${v.tags}">
<label for="cover">Picture: a full https:// link, or a /media/... path (optional)</label><input type="text" id="cover" name="cover" value="${v.cover}">
<label for="cover_alt">What the picture shows, for people who can't see it</label><input type="text" id="cover_alt" name="cover_alt" value="${v.cover_alt}" maxlength="200">
<label for="body">Text</label><textarea class="body" id="body" name="body" maxlength="60000">${v.body}</textarea>
<p class="meta">Markdown: a blank line between paragraphs, **bold**, *italic*, [a link](https://example.com), ## a heading.</p>
<button name="action" value="publish">${isLive ? "Publish the changes" : "Publish"}</button>
<button class="second" name="action" value="preview">Save and preview</button>
<button class="second" name="action" value="save">Save${!item || item.state === "draft" ? " as a draft" : ""}</button>
<p class="meta">Publishing makes this entry live at once. Nothing else that's waiting goes with it.</p></form>`,
    { signedIn: true, status: opts.status },
  );
}

async function writeNew(env: Env, req: Request): Promise<Response> {
  const tz = String((await content.siteData(env.DB, true)).timezone || "UTC");
  return writeForm(env, req, null, { stream: "", title: "", summary: "", date: analytics.localDay(new Date(), tz), tags: "", cover: "", cover_alt: "", body: "" });
}

async function writeEdit(env: Env, req: Request, id: string): Promise<Response> {
  const item = await desk.get(env.DB, id);
  return writeForm(env, req, item, valuesOf(item), { saved: new URL(req.url).searchParams.has("saved") });
}

async function writeSave(env: Env, req: Request, id: string): Promise<Response> {
  const form = await req.formData();
  const values = Object.fromEntries(desk.FIELDS.map((k) => [k, String(form.get(k) ?? "")])) as DeskValues;
  let current: desk.DeskEntry | null = id === "new" ? null : await desk.get(env.DB, id);
  if (form.get("csrf") !== (await owner.csrf(req))) return writeForm(env, req, current, values, { error: "This form expired. Try again.", status: 403 });
  const action = String(form.get("action") ?? "save");
  const version = Number.parseInt(String(form.get("version") ?? ""), 10);
  let saved: content.Item;
  try {
    saved = await desk.save(env.DB, current ? current.id : null, Number.isNaN(version) ? null : version, values);
    current = await desk.get(env.DB, saved.id);
    if (action === "publish") {
      await desk.publish(env.DB, saved.id, saved.version);
      return Response.redirect(new URL(`/review/write?published=${saved.id}`, req.url).href, 303);
    }
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return writeForm(env, req, current, values, { error: deskError(e), status: e.status });
  }
  if (action === "preview") return Response.redirect(new URL(`/review/write/${saved.id}/preview`, req.url).href, 303);
  return Response.redirect(new URL(`/review/write/${saved.id}?saved=1`, req.url).href, 303);
}

/** The entry's page as publishing it now would make it, a draft included. */
async function writePreview(env: Env, req: Request, id: string): Promise<Response> {
  const item = await desk.get(env.DB, id);
  const v = await site.proposedView(env.DB, [{ id, version: item.version }], id);
  const t = await themes.load(env.DB, String(v.site.theme));
  const origin = new URL(req.url).origin;
  const e = v.entries.find((x) => x.id === id && !x.external_url);
  let body: string;
  if (t) body = e ? theme.render(t, "entry", theme.entryView(v, e, "preview", origin)) : theme.render(t, "home", theme.homeView(v, "preview", origin));
  else body = await (e ? site.entryPage(v, e.page)! : site.home(v)).text();
  body = await inlineCss(t, v, body);
  const btn = "font:600 15px/1 -apple-system,sans-serif;border-radius:6px;padding:12px 16px;border:0;cursor:pointer";
  const bar = `<div style="position:sticky;top:0;z-index:99;background:#1c1f1d;color:#fff;font:15px/1.4 -apple-system,sans-serif;padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
<span>Preview: not live until you publish.</span><a style="${btn};background:#fff;color:#1c1f1d;text-decoration:none" href="/review/write/${esc(id)}">Back to writing</a></div>`;
  return respond(raw(body.replace(/<body([^>]*)>/, `<body$1>${bar}`)), {
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    csp: THEME_CSP,
  });
}

// --- owner: the site's history, and putting it back -------------------------------------

const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const KIND_NAME: Record<string, string> = { site: "site", entry: "entry", card: "card", note: "note" };

function byWhom(p: history.Publish): string {
  if (!p.approval_id) return "you";
  const who = p.requested_by.replace(/^assistant:/, "") || "your assistant";
  return `you approved ${who}'s request`;
}

async function historyPage(env: Env): Promise<Response> {
  const list = await history.publishes(env.DB);
  return ownerPage(
    "History",
    html`<h1>History</h1><p class="meta">Every time the site changed, newest first. You can put the site back to how it was after any of them; that is a new change, and it can be undone the same way.</p>
${list.length
  ? list.map(
      (p, i) => html`<div class="card"><div class="meta">${when(p.created_at)} · ${byWhom(p)}</div>${p.note ? html`<p>${p.note}</p>` : ""}${p.items.map(
        (it) => html`<h2 style="margin-top:8px">${it.label}</h2><div class="meta">${KIND_NAME[it.kind] ?? it.kind} · ${it.removed ? "taken off" : "published"}</div>`,
      )}${i === 0 ? html`<p class="meta">This is the site now.</p>` : html`<a class="go" href="/review/history/${String(p.id)}">Put the site back to this →</a>`}</div>`,
    )
  : html`<p class="meta">Nothing has been published yet.</p>`}`,
    { signedIn: true },
  );
}

async function revertPage(env: Env, req: Request, id: number, error = ""): Promise<Response> {
  const { publish, changes: plan } = await history.plan(env.DB, id);
  return ownerPage(
    "Put the site back",
    html`<h1>Put the site back?</h1><p>Back to how it was after the change on ${when(publish.created_at)}.</p>${error ? html`<p class="error">${error}</p>` : ""}
${raw(await embedReviewFor(env.DB, plan, new URL(req.url).origin))}${raw(await privateReviewWarning(env.DB,plan))}
${plan.length
  ? html`<div class="card">${plan.map(
      (c) =>
        html`<h2 style="margin-top:8px">${c.label}</h2><div class="meta">${KIND_NAME[c.kind] ?? c.kind} · ${c.action === "take off" ? "taken off" : "put back"}</div>${
          c.deleted ? changes.takenOff(c.label) : c.live ? changes.whatChanged(c.kind, c.data, c.live) : changes.whatItSays(c.kind, c.data, true)
        }`,
    )}</div>
<form method="post"><input type="hidden" name="csrf" value="${await owner.csrf(req)}"><label>Why (kept with the history; optional)</label><textarea name="note" rows="2"></textarea><button data-busy="${busyWord(plan.length, "Putting back")}">Put the site back to this</button></form>
<p class="meta">This goes live at once. Anything your assistant was drafting on these items is set aside; it stays in each item's history.</p>`
  : html`<p>The site already matches this.</p>`}
<p><a href="/review/history">Back to the history</a></p>`,
    { signedIn: true, script: BUSY_JS },
  );
}

async function revertDo(env: Env, req: Request, id: number): Promise<Response> {
  const form = await req.formData();
  if (form.get("csrf") !== (await owner.csrf(req))) return revertPage(env, req, id, "This form expired. Try again.");
  try {
    await history.revert(env.DB, id, String(form.get("note") ?? ""), new URL(req.url).origin);
  } catch (e) {
    if (e instanceof ApiError) return revertPage(env, req, id, e.message);
    throw e;
  }
  return ownerPage("Put back", html`<h1>Your site is back</h1><p>It's live now as it was then.</p><p><a class="button" href="/">See your site</a></p><p><a href="/review/history">Back to the history</a></p>`, { signedIn: true });
}

// --- visitors: the beacon's endpoint ------------------------------------------------------

function cookieValue(req: Request, name: string): string | null {
  const m = (req.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}

/** Always 204: the page has no use for an answer. */
async function collectBeacon(env: Env, req: Request): Promise<Response> {
  const raw = await req.text().catch(() => "");
  await analytics.collect(env.DB, raw, {
    ip: req.headers.get("cf-connecting-ip") ?? "",
    ua: (req.headers.get("user-agent") ?? "").slice(0, 400),
    notrack: !!cookieValue(req, analytics.NOTRACK_COOKIE),
    host: new URL(req.url).hostname,
  });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

const BEACON_HEADERS = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" };

// --- the router ----------------------------------------------------------------

/**
 * HEAD is GET without the body, on every address: it is routed as a GET and
 * answered with the GET's status and headers. (Routes test for GET alone.)
 */
export async function handle(req: Request, env: Env): Promise<Response> {
  const access = await privacy.access(env.DB,req);
  const get = req.method === "HEAD" ? new Request(req,{method:"GET"}) : req;
  let res = access.response ?? await route(get,env);
  if (access.isPrivate && access.gated) res = privacy.noStore(res);
  if (/^\/(recover|invite)(\/|$)/.test(new URL(req.url).pathname)) {res = new Response(res.body,res);res.headers.set("Referrer-Policy","no-referrer");if (!access.isPrivate || !access.gated) res.headers.set("Cache-Control","no-store");}
  if (req.method === "HEAD") return new Response(null,{status:res.status,statusText:res.statusText,headers:res.headers});
  return res;
}

// Every handler is awaited inside the try, so a refusal it throws reaches the
// catch below and becomes the owner's "Something's wrong" page, not a 500.
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;
  try {
    if ((path === "/sw.js" || path === "/manifest.webmanifest" || /^\/app-icon-(192|512)\.png$/.test(path)) && m === "GET") return await appAsset(env,req,path);
    if (path === "/.well-known/porchsite-release" && m === "GET") return json({release:RELEASE,private_floor:await privacy.privateFloor(env.DB,RELEASE)},200,privacy.PRIVATE_HEADERS);
    if (path === "/recover" && m === "GET") return await recoveryPage(req,env);
    if (path === "/recover/options" && m === "POST") {
      const body: any = await req.json(); const r = await owner.recoverOptions(env.DB,req,String(body.code ?? ""));
      return json({options:r.options},200,{"Set-Cookie":r.setCookieHeader,...SETUP_HEADERS});
    }
    if (path === "/recover/verify" && m === "POST") return signedInJson(await owner.recoverVerify(env.DB,req,await req.json()));
    const invite = /^\/invite\/([A-Za-z0-9_-]{32})(\/options|\/verify)?$/.exec(path);
    if (invite && !invite[2] && m === "GET") return ownerPage("Reader invitation",html`<h1>Read this site</h1><p>Create your own passkey to read published pages. This does not give you owner access.</p><form><p class="error" hidden></p><button>Create reader passkey</button></form>`,{headers:SETUP_HEADERS,script:'history.replaceState(null,"","/login");\n'+PASSKEY_JS("invite","/",`invite/${invite[1]}`)});
    if (invite && invite[2] === "/options" && m === "POST") {
      const r = await owner.inviteOptions(env.DB,req,invite[1]); return json({options:r.options},200,{"Set-Cookie":r.setCookieHeader,...SETUP_HEADERS});
    }
    if (invite && invite[2] === "/verify" && m === "POST") return signedInJson(await owner.inviteVerify(env.DB,req,await req.json()));
    // The kit's beacon, whatever the site's look.
    if (path === "/static/a.js" && m === "GET") return new Response(BEACON_JS, { headers: BEACON_HEADERS });
    if (path === "/collect" && m === "POST") return await collectBeacon(env, req);
    // A theme, when the site text names one; otherwise the built-in look.
    if (m === "GET") {
      const themed = await themedPage(req, env, path);
      if (themed) return themed;
    }
    if (path === "/sitemap.xml" && m === "GET") {
      const v = await contentView(req,env,true);
      return new Response(sitemap(v, url.origin, themes.isBuiltIn(String(v.site.theme)) || !!(await themes.load(env.DB, String(v.site.theme)))), {headers:SITEMAP_HEADERS});
    }
    if (path === "/" && m === "GET") return site.home(await contentView(req,env), url.origin);
    // Open to every crawler and agent. Pages that mustn't be indexed (the
    // owner's) say so themselves with noindex, which a crawler can only see
    // if it may fetch them.
    const proof = /^\/\.well-known\/sitekeeper-proof\/([A-Za-z0-9_-]{20,64})$/.exec(path);
    if (proof && m === "GET") {
      const yes = await requests.answerProof(env.DB, proof[1]);
      return new Response(yes ? "ok" : "no", { status: yes ? 200 : 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    }
    if (path === "/robots.txt" && m === "GET") {
      return new Response(robots(url.origin), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    }
    if (/^\/[a-z][a-z0-9-]{0,29}\/[a-z0-9-]{1,80}\/$/.test(path) && m === "GET") {
      const page = site.entryPage(await contentView(req,env), path, url.origin);
      if (page) return page;
    }

    const img = /^\/media\/([0-9a-f]{32}\.(?:jpg|png|webp))$/.exec(path);
    if (img && m === "GET") {
      // Nothing is public before the owner's yes, images included; the owner
      // sees unpublished ones on the review page.
      const isPublic = await media.published(env.DB, img[1]);
      const shown = isPublic || (await owner.signedIn(env.DB, req)) ? await media.serve(env.DB, img[1], isPublic) : null;
      return shown ?? site.notFound(await contentView(req,env), url.origin);
    }

    const up = /^\/upload\/([A-Za-z0-9_-]{32})$/.exec(path);
    if (up && (m === "GET" || m === "POST")) return await uploadPage(env, req, up[1]);

    if (path === "/setup" && m === "GET") return await setupPage(req, env);
    if (path === "/setup/options" && m === "POST") {
      const body = (await req.json().catch(() => ({}))) as { code?: string; name?: string };
      const r = await owner.setupOptions(env.DB, req, env.SETUP_CODE, String(body.code ?? ""), String(body.name ?? "").slice(0, 80));
      return json({ options: r.options }, 200, { "Set-Cookie": r.setCookieHeader });
    }
    if (path === "/setup/verify" && m === "POST") {
      return signedInJson(await owner.setupVerify(env.DB, req, env.SETUP_CODE, await req.json()));
    }
    const add = /^\/passkey\/([A-Za-z0-9_-]{32})(\/options|\/verify)?$/.exec(path);
    if (add && !add[2] && m === "GET") return await addPasskeyPage(env, add[1]);
    if (add && add[2] === "/options" && m === "POST") {
      const r = await owner.addOptions(env.DB, req, add[1]);
      return json({ options: r.options }, 200, { "Set-Cookie": r.setCookieHeader });
    }
    if (add && add[2] === "/verify" && m === "POST") {
      return signedInJson(await owner.addVerify(env.DB, req, await req.json()));
    }
    if (path === "/login" && m === "GET") return await loginPage(req, env);
    if (path === "/login/options" && m === "POST") {
      const r = await owner.loginOptions(env.DB, req);
      return json({ options: r.options }, 200, { "Set-Cookie": r.setCookieHeader });
    }
    if (path === "/login/verify" && m === "POST") {
      return signedInJson(await owner.loginVerify(env.DB, req, await req.json()));
    }
    if (path === "/logout" && m === "POST") {
      const form = await req.formData();
      if (form.get("csrf") === (await owner.csrf(req))) {
        return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": await owner.signOut(env.DB, req) } });
      }
      return Response.redirect(new URL("/review", req.url).href, 303);
    }

    if (path === "/authorize") {
      return await (m === "POST" ? authorizePost(env, req) : authorizeGet(env, req));
    }

    if (path === "/review" || path.startsWith("/review/")) {
      const gate = await requireOwner(req, env);
      if (gate) return gate;
      if (path === "/review/readers") return await readersPage(req,env);
      if (path === "/review/alerts" || path.startsWith("/review/alerts/")) return await alertsPage(env,req,path);
      if (path === "/review" && m === "GET") return await reviewIndex(env, req);
      // Share cards: the owner's browser draws them (sharecards.ts).
      if (path === "/review/import") {
        if (m === "POST") {
          const form = await req.formData();
          if (form.get("csrf") !== (await owner.csrf(req))) return await importPage(req, "This form expired. Try again.");
          const f = form.get("file") as unknown as File | null;
          if (!f || typeof f === "string" || !f.size) return await importPage(req, "Choose the file your assistant gave you.");
          if (f.size > importer.MAX_FILE) return await importPage(req, "That file is over 25 MB.");
          try {
            const done = await importer.importFile(env.DB, await f.text());
            alerts.schedule(env.DB,done.approval);
            return Response.redirect(new URL(`/review/${done.approval}`, req.url).href, 303);
          } catch (e) {
            if (!(e instanceof ApiError)) throw e;
            const problems = ((e.extra as { problems?: { item: number; message: string }[] })?.problems ?? []).map((p) => `Item ${p.item}: ${p.message}`);
            return await importPage(req, e.message, problems);
          }
        }
        return await importPage(req);
      }
      if (path === "/review/cards.json" && m === "GET") return json({ cards: await sharecards.missing(env.DB, url.hostname) });
      const card = /^\/review\/cards\/([a-z]{2,8}_[0-9a-f]{4,40})$/.exec(path);
      if (card && m === "POST") {
        if (req.headers.get("X-CSRF") !== (await owner.csrf(req))) return json({ error: "csrf", message: "This page expired. Reload it." }, 403);
        const version = Number(url.searchParams.get("version"));
        await sharecards.save(env.DB, card[1], version, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 204 });
      }
      if (path === "/review/passkeys") {
        if (m === "POST") {
          const form = await req.formData();
          if (form.get("csrf") === (await owner.csrf(req))) return await passkeysPage(env, req, await owner.createPasskeyLink(env.DB,req));
        }
        return await passkeysPage(env, req);
      }
      if (path === "/review/assistants") {
        if (m === "POST") {
          const form = await req.formData();
          if (form.get("csrf") !== (await owner.csrf(req))) return await assistantsPage(env, req);
          if (form.get("make_key")) {
            const name = String(form.get("key_name") ?? "").trim().slice(0, 40) || "Assistant";
            return await assistantsPage(env, req, undefined, { name, ...(await keys.create(env.DB, name)) });
          }
          if (form.get("revoke_key")) {
            await keys.revoke(env.DB, String(form.get("revoke_key")));
            return await assistantsPage(env, req);
          }
          return await assistantsPage(env, req, String(form.get("revoke") ?? ""));
        }
        return await assistantsPage(env, req);
      }
      if (path === "/review/stats" && m === "GET") return await statsPage(env, req);
      if (path === "/review/history" && m === "GET") return await historyPage(env);
      const back = /^\/review\/history\/(\d{1,12})$/.exec(path);
      if (back) return await (m === "POST" ? revertDo(env, req, Number(back[1])) : revertPage(env, req, Number(back[1])));
      if (path === "/review/write" && m === "GET") return await writeIndex(env, req);
      if (path === "/review/write/new" && m === "GET") return await writeNew(env, req);
      const wp = /^\/review\/write\/([a-z]{2,8}_[0-9a-f]{4,40})\/preview$/.exec(path);
      if (wp && m === "GET") return await writePreview(env, req, wp[1]);
      const w = /^\/review\/write\/(new|[a-z]{2,8}_[0-9a-f]{4,40})$/.exec(path);
      if (w) return await (m === "POST" ? writeSave(env, req, w[1]) : writeEdit(env, req, w[1]));
      const pv = /^\/review\/([A-Za-z0-9_-]{8,40})\/preview(\/.*)?$/.exec(path);
      if (pv && m === "GET") return await reviewPreview(env, req, pv[1], pv[2] || "/");
      const rid = /^\/review\/([A-Za-z0-9_-]{8,40})$/.exec(path);
      if (rid) return await (m === "POST" ? reviewDecide(env, req, rid[1]) : reviewShow(env, req, rid[1]));
    }

    return await notFoundPage(req, env);
  } catch (e) {
    if (e instanceof privacy.PrivateContentDenied) return privacy.blankResponse();
    if (e instanceof ApiError) {
      if (req.headers.get("content-type")?.includes("json") || path.endsWith("/options") || path.endsWith("/verify")) {
        return json(e.toJSON(), e.status);
      }
      return ownerPage("Problem", html`<h1>Something's wrong</h1><p>${e.message}</p>`, { status: e.status });
    }
    throw e;
  }
}

export { esc };

async function embedReviewFor(db: D1Database, changes: {id:string;kind:string;data:Record<string,any>;deleted?:boolean}[], origin:string):Promise<string> {
  if (!changes.some(c=>c.kind === "site" || (c.kind === "entry" && String(c.data.body??"").includes("!embed[")))) return "";
  const live = await approvals.liveWith(db, []), proposed = new Map(live.map(r=>[r.id,r]));
  for(const c of changes) { if(c.deleted) proposed.delete(c.id); else proposed.set(c.id,c); }
  return embedReview(live,[...proposed.values()],changes,origin);
}

async function recoveryPage(req: Request,env: Env): Promise<Response> {
  if (!(await owner.hasOwner(env.DB))) return ownerPage("Recovery",html`<h1>This site has no owner yet.</h1>`,{status:409,headers:SETUP_HEADERS});
  const code = (new URL(req.url).searchParams.get("code") ?? "").slice(0,200);
  return ownerPage("Recover owner access",html`<h1>Recover owner access</h1><p>Use this if you can't sign in on any device. Your recovery code replaces all your old passkeys, so a lost or stolen device can't get back in. Everyone is signed out; unused reader invitations are cancelled. Readers keep their passkeys and just sign in again.</p><form><label>Recovery code</label><input type="password" name="code" autocomplete="off" value="${code}" required><p class="error" hidden></p><button>Recover my site</button></form>`,{headers:SETUP_HEADERS,script:SETUP_JS+PASSKEY_JS("recover","/review")});
}
async function readersPage(req: Request,env: Env): Promise<Response> {
  const csrf = await owner.csrf(req); let link = "";
  if (req.method === "POST") {
    const form = await req.formData(); if (form.get("csrf") !== csrf) throw new ApiError(403,"csrf","This form expired. Try again.");
    const id = String(form.get("id") ?? "");
    if (form.get("action") === "revoke") await owner.revokeReader(env.DB,id);
    else if (form.get("action") === "revoke-invite") await owner.revokeInvite(env.DB,id);
    else { const invite = await owner.createReaderInvite(env.DB,String(form.get("name") ?? "Reader"),req); link = new URL(`/invite/${invite.token}`,req.url).href; }
  }
  const readers: any[] = await owner.listReaders(env.DB);
  const timeZone = String((await contentView(req,env,true)).site.timezone || "UTC");
  const date = (value: string) => dateString(new Date(value),{month:"long",day:"numeric",year:"numeric"},timeZone);
  const form = (r: any, invite: boolean) => html`<form method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${r.id}">${invite ? html`<button class="second" name="action" value="revoke-invite">Cancel invitation</button>` : html`<button class="warn" name="action" value="revoke">Remove ${r.name}</button>`}</form>`;
  return ownerPage("Readers",html`<h1>Readers</h1><p>Invite someone to read this site with their own passkey. An invitation link works once and lasts seven days. Revoking someone stops their access right away; pages they already opened stay on their device.</p>${link ? html`<p class="ok">Give this one-time link privately: <a href="${link}">${link}</a></p>` : ""}<form method="post"><input type="hidden" name="csrf" value="${csrf}"><label>Reader name</label><input type="text" name="name" maxlength="80" required><button>Create invitation</button></form><h2>Readers</h2>${readers.filter(r=>r.used_at).map(r=>html`<section class="card"><h3>${r.name}</h3><p>Added ${date(r.created_at)}</p><p>${r.last_signed_in ? `Last signed in ${date(r.last_signed_in)}` : "Not signed in yet"}</p>${r.revoked ? html`<p>Removed</p>` : form(r,false)}</section>`)}<h2>Unused invitations</h2>${readers.filter(r=>!r.used_at && r.expires_at && !r.revoked).map(r=>html`<section class="card"><h3>${r.name}</h3><p>Expires ${date(r.expires_at)}</p>${r.expires_at <= new Date().toISOString() ? html`<p>Expired</p>` : ""}${form(r,true)}</section>`)}`,{signedIn:true,headers:SETUP_HEADERS});
}

async function privateReviewWarning(db: D1Database, proposed: {kind:string;data:Record<string,any>;deleted?:boolean}[]): Promise<string> {
  const live = await privacy.livePrivate(db);let out="";
  for (const item of proposed) if (item.kind === "site") {
    const mode = !!item.data.private && !item.deleted;
    if (live && !mode) out += '<h2 class="warn">This makes the site public.</h2>';
    else if (mode && !live) out += '<h2 class="warn">Passkeys will be required to read this site.</h2><p class="warn">Sign-in, setup and recovery stay available so you can get back in; setup redirects after you claim the site. The release id and private-mode minimum stay visible so updates can be checked. Assistant-connection details stay available so assistants can connect. None of these shows your site content. Pictures and pages people already saved, and search-engine copies, stay available. Pages already loading may finish opening.</p>';
  }
  return out;
}

function alertControls(csrf: string, device: string, fingerprint: string) {
  return html`<section
    id="approval-alerts"
    data-csrf="${csrf}"
    data-device="${device}"
    data-fingerprint="${fingerprint}"
  >
    <p data-alert-status>Alerts are ${device ? "on" : "off"} for this device</p>
    <button type="button" data-alert-toggle>
      Turn alerts ${device ? "off" : "on"}
    </button>
    <p data-alert-error class="error" hidden></p>
    <p class="meta">On iPhone (iOS 16.4 or later): Share → Add to Home Screen → open from the icon → turn alerts on.</p>
    <p><a href="/review/alerts">Manage alert devices</a></p>
  </section>`;
}
const ALERT_HELP =
  "Alerts are a nudge, not a guarantee. Phones and browsers can delay or drop them. Your assistant still sends you the link. On iPhone use iOS 16.4 or later: Share → Add to Home Screen → open from the icon → turn alerts on. A site icon appears on your Home Screen; open that icon instead of a browser tab. The site name and fixed message may appear on your lock screen. A notification already sent cannot be recalled.";
async function alertsPage(
  env: Env,
  req: Request,
  path: string,
): Promise<Response> {
  if (req.method === "GET" && path === "/review/alerts/key") {
    await alerts.identity(env.DB, req);
    return json({ public_key: (await alerts.keys(env.DB)).public_key });
  }
  if (
    req.method === "POST" &&
    ["/review/alerts/subscribe", "/review/alerts/remove"].includes(path)
  ) {
    if (
      req.headers.get("Origin") !== new URL(req.url).origin ||
      req.headers.get("X-CSRF") !== (await owner.csrf(req))
    )
      return json(
        { error: "csrf", message: "This page expired. Reload it." },
        403,
      );
    if (Number(req.headers.get("Content-Length") || 0) > 8192)
      return json({ error: "invalid" }, 422);
    let value: any;
    try {
      const text = await req.text();
      if (text.length > 8192) throw new Error();
      value = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
    } catch {
      return json({ error: "invalid" }, 422);
    }
    if (path.endsWith("/subscribe")) {
      const id = await alerts.subscribe(
        env.DB,
        req,
        value,
        (env as Env & { SITE_URL?: string }).SITE_URL ||
          new URL(req.url).origin,
      );
      return json({ id }, 200, {
        "Set-Cookie": `${alerts.DEVICE_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      });
    }
    if (typeof value.id !== "string") return json({ error: "invalid" }, 422);
    await alerts.remove(env.DB, req, value.id);
    return json(
      { ok: true },
      200,
      value.id === alerts.cookie(req)
        ? {
            "Set-Cookie": `${alerts.DEVICE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
          }
        : {},
    );
  }
  if (req.method !== "GET" || path !== "/review/alerts")
    return json({ error: "not_found" }, 404);
  const devices = await alerts.devices(env.DB),
    csrf = await owner.csrf(req),
    device = devices.find((d) => d.id === alerts.cookie(req));
  const data = await content.siteData(env.DB, true),
    zone = String(data.timezone || "UTC");
  const date = (n: number) =>
    dateString(
      new Date(n),
      { year: "numeric", month: "long", day: "numeric" },
      zone,
    );
  return ownerPage(
    "Alerts",
    html`<h1>Alerts</h1>
      <p>${ALERT_HELP}</p>
      ${alertControls(csrf, device?.id ?? "", device?.fingerprint ?? "")}<figure><img src="${String(data.logo||"/app-icon-192.png")}" alt="Site icon" width="48" height="48"><figcaption>Open your site from its Home Screen icon, then choose “Turn alerts on”.</figcaption></figure>${devices.map(
        (d) =>
          html`<section class="card">
            <h2>${d.label}</h2>
            <p>Added ${date(d.created_at)}</p>
            <p>
              ${d.last_used_at
                ? `Last used ${date(d.last_used_at)}`
                : "Not used yet"}
            </p>
            <button class="ghost" data-remove-alert="${d.id}">
              Remove ${d.label}
            </button>
          </section>`,
      )}`,
    {
      signedIn: true,
      script:
        ALERT_JS +
        `\ndocument.querySelectorAll('[data-remove-alert]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{const r=await fetch('/review/alerts/remove',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF':document.getElementById('approval-alerts').dataset.csrf},body:JSON.stringify({id:button.dataset.removeAlert})});if(!r.ok)throw Error();location.reload();}catch{button.disabled=false;button.textContent='Could not remove. Try again.';}}));`,
    },
  );
}
async function appAsset(
  env: Env,
  req: Request,
  path: string,
): Promise<Response> {
  const headers = {
    "Cache-Control": "no-cache, no-transform",
    "X-Content-Type-Options": "nosniff",
  };
  if (path === "/sw.js")
    return new Response(SW_JS, {
      headers: {
        ...headers,
        "Content-Type": "text/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/",
      },
    });
  const icon = /^\/app-icon-(192|512)\.png$/.exec(path);
  if (icon)
    return new Response(
      Uint8Array.from(atob(ICONS[icon[1] as keyof typeof ICONS]), (c) =>
        c.charCodeAt(0),
      ),
      { headers: { ...headers, "Content-Type": "image/png" } },
    );
  const hidden =
    (await privacy.livePrivate(env.DB)) && !(await owner.signedIn(env.DB, req));
  const data = hidden ? {} : await content.siteData(env.DB, true);
  const icons = [192, 512].map((n) => ({
    src: `/app-icon-${n}.png`,
    sizes: `${n}x${n}`,
    type: "image/png",
  }));
  if (typeof data.logo === "string" && data.logo)
    icons.unshift({ src: data.logo, sizes: "any", type: "" });
  return new Response(
    JSON.stringify({
      name: String(data.title || "Porchsite"),
      short_name: String(data.title || "Porchsite").slice(0, 30),
      id: "/review",
      start_url: "/review",
      scope: "/",
      display: "standalone",
      icons,
    }),
    {
      headers: {
        "Content-Type": "application/manifest+json",
        "Cache-Control": "private, no-store, no-transform",
        Vary: "Cookie",
      },
    },
  );
}
