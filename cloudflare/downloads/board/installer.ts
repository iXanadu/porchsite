/**
 * The one-page installer (RA-4): get.porchsite.dev/install/. For an owner
 * whose assistant can't make Cloudflare calls itself. The owner makes a
 * Cloudflare API token from a pre-filled link, pastes it here with the site's
 * name, and this Worker runs the install guide's steps from Cloudflare's own
 * network: the database and its layout, the sign-in storage, a one-time
 * setup code (stored in the site's database, so no secret is left behind),
 * the upload of the current release, and the address. The token is used
 * for those calls during the request and is never stored or logged.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" })[c]!);

type Env = { ASSETS: Fetcher };
const API = "https://api.cloudflare.com/client/v4";
const NAME = /^[a-z][a-z0-9-]{0,62}$/;

// The token's permissions, pre-filled where Cloudflare accepts the link
// (a key it doesn't know is silently left out, so the page lists them too).
const PERMISSIONS = [
  { key: "workers_scripts", type: "edit", label: "Workers Scripts: Edit" },
  { key: "d1", type: "edit", label: "D1: Edit" },
  { key: "workers_kv_storage", type: "edit", label: "Workers KV Storage: Edit" },
  { key: "account_settings", type: "read", label: "Account Settings: Read" },
];
const TOKEN_LINK = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
  JSON.stringify(PERMISSIONS.map(({ key, type }) => ({ key, type }))),
)}&name=Porchsite`;

interface Answer {
  success?: boolean;
  result?: any;
  errors?: { code: number; message: string }[];
}

class Stop extends Error {
  constructor(
    message: string,
    readonly need = "",
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function cf(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; a: Answer }> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const r = await fetch(`${API}${path}`, init);
  let a: Answer = {};
  try {
    a = (await r.json()) as Answer;
  } catch {
    a = {};
  }
  return { status: r.status, a };
}

const why = (a: Answer) => (a.errors ?? []).map((e) => `${e.message} (${e.code})`).join("; ") || "no reason given";

function random(n: number): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => chars[b % chars.length]).join("");
}

async function codeHash(code: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function asset(env: Env, path: string): Promise<Response> {
  const r = await env.ASSETS.fetch(new Request(`https://get.porchsite.dev${path}`));
  if (!r.ok) throw new Stop(`This installer couldn't read ${path} (${r.status}). Try again later.`);
  return r;
}

async function run(env: Env, input: { cf_token?: string; site_name?: string; token?: string; name?: string; account?: string; subdomain?: string }) {
  const steps: string[] = [];
  const token = String(input.cf_token ?? input.token ?? "").trim();
  const name = String(input.site_name ?? input.name ?? "").trim().toLowerCase();
  if (!token) throw new Stop("Paste the token you made at Cloudflare.");
  if (!NAME.test(name)) throw new Stop("The site's name: lowercase letters, digits and dashes, starting with a letter, up to 63.");

  // 1. Which account.
  const acc = await cf(token, "GET", "/accounts?per_page=50");
  if (!acc.a.success) throw new Stop(`Cloudflare didn't accept that token: ${why(acc.a)}. Make a new one from the link above.`);
  const accounts = ((acc.a.result ?? []) as { id: string; name: string }[]).map((x) => ({ id: x.id, name: x.name }));
  if (!accounts.length) throw new Stop("That token can't see any Cloudflare account. Give it access to your account (Account Settings: Read).");
  const account = input.account ? accounts.find((x) => x.id === input.account) : accounts.length === 1 ? accounts[0] : undefined;
  if (!account) throw new Stop("Which Cloudflare account should the site go on?", "account", { accounts });
  const A = `/accounts/${account.id}`;
  steps.push(`Account: ${account.name}.`);

  // The current release, from this site's own files.
  const latest = (await (await asset(env, "/latest.json")).json()) as { version: string; all_migrations: { name: string }[] };

  // 2. The database.
  let db = await cf(token, "POST", `${A}/d1/database`, { name });
  let dbId: string | undefined = db.a.result?.uuid;
  if (!dbId) {
    const found = await cf(token, "GET", `${A}/d1/database?name=${encodeURIComponent(name)}`);
    dbId = ((found.a.result ?? []) as { uuid: string; name: string }[]).find((x) => x.name === name)?.uuid;
    if (!dbId) throw new Stop(`Cloudflare wouldn't make the database: ${why(db.a)}. The token needs D1: Edit.`);
    steps.push(`Database ${name}: already there, kept.`);
  } else steps.push(`Database ${name}: made.`);
  const q = async (sql: string, params?: unknown[]) => {
    const r = await cf(token, "POST", `${A}/d1/database/${dbId}/query`, params ? { sql, params } : { sql });
    if (!r.a.success) throw new Stop(`The database refused a step: ${why(r.a)}.`);
    return r.a.result?.[0]?.results ?? [];
  };

  // This page only makes new sites. One that's been claimed is updated by its
  // owner's assistant, with the owner's yes (SPEC §4 Updates), never from here.
  const hasOwner = ((await q("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'owner'")) as { n: number }[])[0]?.n > 0;
  if (hasOwner && ((await q("SELECT count(*) AS n FROM owner")) as { n: number }[])[0]?.n > 0)
    throw new Stop(`There's already a claimed site named ${name} on ${account.name}, so nothing was changed. This page only makes new sites. Check the name and the token are the ones you meant; to update an existing site, ask its assistant.`);

  // 3. Its layout: every migration the database hasn't had, each recorded with it.
  await q("CREATE TABLE IF NOT EXISTS _sitekeeper_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const have = new Set(((await q("SELECT name FROM _sitekeeper_migrations")) as { name: string }[]).map((r) => r.name));
  let applied = 0;
  for (const m of latest.all_migrations) {
    if (have.has(m.name)) continue;
    const sql = await (await asset(env, `/v/${latest.version}/migrations/${m.name}`)).text();
    await q(`${sql}\n;INSERT INTO _sitekeeper_migrations VALUES ('${m.name.replace(/'/g, "")}', datetime('now'));`);
    applied++;
  }
  steps.push(applied ? `Database layout: ${applied} file${applied === 1 ? "" : "s"} applied.` : "Database layout: already up to date.");

  // 4. Sign-in storage.
  const title = `${name}-oauth`;
  let kv = await cf(token, "POST", `${A}/storage/kv/namespaces`, { title });
  let kvId: string | undefined = kv.a.result?.id;
  if (!kvId) {
    const list = await cf(token, "GET", `${A}/storage/kv/namespaces?per_page=100`);
    kvId = ((list.a.result ?? []) as { id: string; title: string }[]).find((x) => x.title === title)?.id;
    if (!kvId) throw new Stop(`Cloudflare wouldn't make the sign-in storage: ${why(kv.a)}. The token needs Workers KV Storage: Edit.`);
  }
  steps.push("Sign-in storage: ready.");

  // 5. A one-time setup code, in the site's database (claiming deletes it).
  const claimed = ((await q("SELECT count(*) AS n FROM owner")) as { n: number }[])[0]?.n > 0;
  let code = "";
  if (!claimed) {
    code = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const created = new Date().toISOString();
    const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
    const issued = await cf(token, "POST", `${A}/d1/database/${dbId}/query`, {batch: [
      {sql: "DELETE FROM setup_codes WHERE NOT EXISTS (SELECT 1 FROM owner WHERE id = 1)"},
      {sql: "INSERT INTO setup_codes (code_hash, created_at, expires_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM owner WHERE id = 1)", params: [await codeHash(code), created, expires]},
    ]});
    if (!issued.a.success) throw new Stop("The database could not issue a setup link.");
    if (!issued.a.result?.[1]?.meta?.changes) throw new Stop("This site already has an owner. Open its sign-in page instead.");
  }

  // Establish the known install origin before uploading new-site metadata.
  let sub = await cf(token, "GET", `${A}/workers/subdomain`);
  let subdomain: string | undefined = sub.a.result?.subdomain;
  if (!subdomain) {
    const pick = String(input.subdomain ?? "").trim().toLowerCase();
    if (!pick) throw new Stop("Your account has no workers.dev name yet. Pick one (it's shared by everything on your account, e.g. your name).", "subdomain");
    if (!NAME.test(pick)) throw new Stop("A workers.dev name: lowercase letters, digits and dashes, starting with a letter.", "subdomain");
    sub = await cf(token, "PUT", `${A}/workers/subdomain`, { subdomain: pick });
    if (!sub.a.success) throw new Stop(`That workers.dev name didn't work: ${why(sub.a)}. Pick another.`, "subdomain");
    subdomain = pick;
  }
  const url = `https://${name}.${subdomain}.workers.dev`;

  // 6. The site itself: the release's own file, as the guide uploads it.
  const bundle = await (await asset(env, `/v/${latest.version}/sitekeeper.js`)).blob();
  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "sitekeeper.js",
          compatibility_date: "2026-08-15",
          compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
          keep_bindings: claimed ? ["plain_text"] : [],
          bindings: [
            { type: "d1", name: "DB", id: dbId },
            { type: "kv_namespace", name: "OAUTH_KV", namespace_id: kvId },
            ...(!claimed ? [{ type: "plain_text", name: "SITE_URL", text: url }] : []),
          ],
          observability: { enabled: true, redact_query_string: true },
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.append("sitekeeper.js", new Blob([bundle], { type: "application/javascript+module" }), "sitekeeper.js");
  const up = await cf(token, "PUT", `${A}/workers/scripts/${name}`, form);
  if (!up.a.success) throw new Stop(`Cloudflare wouldn't take the site: ${why(up.a)}. The token needs Workers Scripts: Edit.`);
  steps.push(`Site: Porchsite ${latest.version} uploaded.`);

  // 7. The address.
  const on = await cf(token, "POST", `${A}/workers/scripts/${name}/subdomain`, { enabled: true, previews_enabled: false });
  if (!on.a.success) throw new Stop(`Cloudflare wouldn't turn the address on: ${why(on.a)}.`);
  steps.push(`Address: ${url} (a new address can take a minute or two to answer).`);

  return { ok: true, url, setup: code ? `${url}/setup#code=${code}` : "", claimed, release: latest.version, steps };
}

const PAGE = (nonce: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Install Porchsite</title><style>
body{font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f2f2;color:#201e1d;margin:0}
.wrap{max-width:640px;margin:0 auto;padding:28px 18px 64px}h1{font-size:28px;margin:0 0 6px}h2{font-size:19px;margin:28px 0 6px}
.meta{color:#5c5855;font-size:15px}label{display:block;margin:14px 0 4px;font-weight:600}input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid #cfcbc9;border-radius:8px;background:#fff}
button,.button{display:inline-block;margin-top:16px;font:inherit;font-weight:600;padding:11px 18px;border:0;border-radius:8px;background:#00647f;color:#fff;text-decoration:none;cursor:pointer}
button[disabled]{opacity:.6}.card{background:#fff;border:1px solid #cfcbc9;border-radius:10px;padding:14px 16px;margin:12px 0}.error{color:#a8000f}ol li,ul li{margin:4px 0}.addr{font-size:20px;font-weight:700;word-break:break-all;margin:4px 0 12px}.wait{background:#fff4d6;border:2px solid #b07a00;border-radius:10px;padding:12px 16px;margin:12px 0}.wait b{display:block;font-size:20px;margin-bottom:4px}.secret{-webkit-text-security:disc;text-security:disc}code{background:#e9e6e4;padding:1px 5px;border-radius:4px}
</style></head><body><div class="wrap">
<h1>Install Porchsite</h1>
<p>A website your assistant keeps up to date, on your own free Cloudflare account. Nothing on it goes live without your yes.</p>
<h2>1. Make a Cloudflare token</h2>
<p>No Cloudflare account yet? <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener">Make a free one</a>, then <b>verify your email</b> from the message Cloudflare sends: it won't make tokens until you do.</p>
<p class="meta">Verified, but Cloudflare still says to verify, or Create Token just spins? Its records can lag: wait a few minutes, sign out and back in, and try again.</p>
<p>Signed in, open <a href="${esc(TOKEN_LINK)}" target="_blank" rel="noopener">this pre-filled token page</a>. If the form opens empty (it can, right after signing in), open the link again. Check it lists these, add any that are missing, and create the token:</p>
<ul>${PERMISSIONS.map((p) => `<li>${esc(p.label)}</li>`).join("")}</ul>
<p class="meta">The token goes to this installer only for the install, over HTTPS, and is never stored. When you're done you can delete it at Cloudflare; the site doesn't need it.</p>
<h2>2. Name it and install</h2>
<form id="f" autocomplete="off"><label for="site_name">The site's name (part of its address)</label><input id="site_name" name="site_name" required pattern="[a-z][a-z0-9-]{0,62}" placeholder="e.g. rams1976" autocomplete="off" data-1p-ignore data-lpignore="true">
<label for="cf_token">The token</label><input id="cf_token" name="cf_token" type="text" class="secret" required autocomplete="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true">
<p class="meta">Not a password: your browser shouldn't save it, and the page clears it after installing.</p>
<label for="subdomain">Your workers.dev name (only used if your Cloudflare account doesn't have one yet)</label><input id="subdomain" name="subdomain" pattern="[a-z][a-z0-9-]{0,62}" placeholder="e.g. sam" autocomplete="off">
<p class="meta">It's part of every address on your account: the site will be at <i>site-name</i>.<i>this-name</i>.workers.dev.</p>
<div id="extra"></div><button id="go">Install</button></form>
<div id="out"></div>
<p class="meta" style="margin-top:28px">Prefer to have your assistant do it? Tell it: "Set up Porchsite from porchsite.dev." The source is at <a href="https://github.com/iXanadu/porchsite">github.com/iXanadu/porchsite</a>; this installer is <code>cloudflare/downloads/board/installer.ts</code>.</p>
</div><script nonce="${nonce}">
const f = document.getElementById("f"), out = document.getElementById("out"), extra = document.getElementById("extra"), go = document.getElementById("go");
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
f.addEventListener("submit", async (ev) => {
  ev.preventDefault(); go.disabled = true; go.textContent = "Installing… this takes about half a minute";
  out.replaceChildren();
  const body = Object.fromEntries(new FormData(f));
  let r;
  try { r = await (await fetch("/install/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(); }
  catch (e) { r = { ok: false, message: "The installer didn't answer. Check your connection and try again." }; }
  go.disabled = false; go.textContent = "Install";
  document.getElementById("cf_token").value = "";
  // Kept for this tab only, so a reload doesn't lose the claim link.
  if (r.ok) { r.at = Date.now(); try { sessionStorage.setItem(KEEP, JSON.stringify(r)); } catch (e) {} }
  render(r);
});
const KEEP = "porchsite-install";
function render(r) {
  const card = el("div", "", "card");
  if (r.steps && r.steps.length) { const ul = el("ul"); r.steps.forEach((s) => ul.append(el("li", s))); card.append(ul); }
  if (r.ok) {
    card.append(el("h2", "Your site is installed"));
    card.append(el("p", r.url, "addr"));
    const next = el("p", "Then tell your assistant to connect to " + r.url + "/mcp. If its app can't, make it a key on your site's Assistants page.");
    if (r.setup) {
      const started = r.at || Date.now();
      // Until the address answers, nothing else to do: say so loudly, and
      // hold back the next steps so nobody runs ahead.
      const wait = el("div", "", "wait");
      const line = el("p", "");
      wait.append(el("b", "Stop here for a few minutes."), line);
      const tick = () => { const m = Math.floor((Date.now() - started) / 60000), sec = Math.floor((Date.now() - started) / 1000) % 60; line.textContent = "Cloudflare is putting your new address online. Don't open your site or tell your assistant anything yet: it won't work until this finishes. Keep this page open; a Claim button appears here when it's ready (usually 1 to 5 minutes). Waiting " + m + ":" + String(sec).padStart(2, "0") + "."; };
      card.append(wait);
      const timer = setInterval(tick, 1000);
      const show = (late) => {
        clearInterval(timer);
        wait.remove();
        card.append(el("p", "Ready. Last step, yours: claim your site and create your passkey, on the phone or computer you'll approve changes with. That passkey is how you approve everything from now on."));
        const a = el("a", "Claim your site", "button"); a.href = r.setup; a.target = "_blank"; a.rel = "noopener"; card.append(a);
        // As text too: if an assistant's browser ran this page, the link has to
        // reach the owner's own device.
        card.append(el("p", "Not on your own device (your assistant's browser ran this page)? Open this link there instead:", "meta"));
        const link = el("p", r.setup, "addr");
        const copy = el("button", "Copy the link"); copy.type = "button";
        copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.setup); copy.textContent = "Copied"; } catch (e) { copy.textContent = "Select the link and copy it"; } });
        card.append(link, copy);
        card.append(next);
        card.append(el("p", late ? "Your address is taking longer than usual. If the page says it can't be reached, or shows a security error (such as ERR_SSL_VERSION_OR_CIPHER_MISMATCH), wait a few minutes and reload it, or open the link in another browser: Cloudflare is still setting the address up." : "The link works once, for 24 hours. Don't share it or send a picture of it: it's the key to claiming your site.", "meta"));
      };
      // Asked of the installer, never of the new address itself: a browser
      // that looks the name up before it exists remembers the failure.
      // Then the browser itself, on a throwaway name under the same account
      // name: its certificate covers both, so a secure connection there means
      // one to the site will work from here too.
      const host = new URL(r.url).host;
      const poll = async () => {
        try {
          if ((await (await fetch("/install/ready?host=" + encodeURIComponent(host), { cache: "no-store" })).json()).ready) {
            const probe = "https://ready-" + Math.random().toString(36).slice(2, 12) + "." + host.split(".").slice(1).join(".") + "/";
            await fetch(probe, { mode: "no-cors", cache: "no-store" });
            return show(false);
          }
        } catch (e) {}
        if (Date.now() - started > 600000) return show(true);
        setTimeout(poll, 10000);
      };
      tick();
      setTimeout(poll, 10000);
    } else card.append(next);
    f.hidden = true;
  } else {
    card.append(el("p", r.message || "Something went wrong.", "error"));
    // The account picker stays once it's shown, so a later retry keeps the choice.
    if (r.need === "account") {
      extra.replaceChildren();
      extra.append(el("label", "Which account?"));
      const s = document.createElement("select"); s.name = "account";
      (r.accounts || []).forEach((a) => { const o = el("option", a.name); o.value = a.id; s.append(o); });
      extra.append(s);
    }
    if (r.need === "subdomain") {
      const i = document.getElementById("subdomain"); i.required = true; i.focus();
    }
  }
  out.replaceChildren(card);
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}
// Back on this page after a reload: show the last install again, claim link included.
try {
  const saved = JSON.parse(sessionStorage.getItem(KEEP) || "null");
  if (saved && saved.ok && Date.now() - saved.at < 86400000) render(saved);
} catch (e) {}
</script></body></html>`;

/**
 * Whether a new site's address answers yet: in public DNS, and over HTTPS.
 * Resolvers remember "no such name" for 30 minutes (workers.dev's SOA), so
 * the site's own name is never looked up early: DNS is asked about a
 * throwaway name under the same account name, which the account's wildcard
 * answers once it's live.
 */
async function ready(host: string): Promise<boolean> {
  if (!/^[a-z][a-z0-9-]{0,62}\.[a-z0-9][a-z0-9-]{0,62}\.workers\.dev$/.test(host)) return false;
  const probe = `ready-${random(12)}.${host.split(".").slice(1).join(".")}`;
  const resolved = async (doh: string) => {
    const r = await fetch(`${doh}?name=${probe}&type=A`, { headers: { Accept: "application/dns-json" } });
    const a = (await r.json()) as { Status?: number; Answer?: unknown[] };
    return a.Status === 0 && !!a.Answer?.length;
  };
  try {
    if (!(await resolved("https://cloudflare-dns.com/dns-query")) || !(await resolved("https://dns.google/resolve"))) return false;
    const r = await fetch(`https://${host}/robots.txt`, { signal: AbortSignal.timeout(8000) });
    // Cloudflare answers any name under a live account; only the site sends this.
    return r.ok && r.headers.has("X-Porchsite-Release");
  } catch {
    return false;
  }
}

/** /install/, /install/run and /install/ready, or null for any other address. */
export async function installer(req: Request, env: Env): Promise<Response | null> {
  const u = new URL(req.url);
  if (u.pathname === "/install" || u.pathname === "/install/") {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const nonce = random(16);
    return new Response(PAGE(nonce), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' https://*.workers.dev; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (u.pathname === "/install/ready" && req.method === "GET") {
    return new Response(JSON.stringify({ ready: await ready(String(u.searchParams.get("host") ?? "")) }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (u.pathname === "/install/run" && req.method === "POST") {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    let input: Record<string, string> = {};
    try {
      input = (await req.json()) as Record<string, string>;
    } catch {
      return new Response(JSON.stringify({ ok: false, message: "Send the form as JSON." }), { status: 400, headers });
    }
    try {
      return new Response(JSON.stringify(await run(env, input)), { headers });
    } catch (e) {
      if (e instanceof Stop) return new Response(JSON.stringify({ ok: false, message: e.message, need: e.need, ...e.extra }), { status: 422, headers });
      return new Response(JSON.stringify({ ok: false, message: "The installer hit an error it doesn't know. Nothing was left half-done that a second try won't finish: try again." }), { status: 500, headers });
    }
  }
  return null;
}
