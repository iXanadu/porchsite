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
)}&accountId=*&zoneId=all&name=Porchsite`;

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

async function run(env: Env, input: { token?: string; name?: string; account?: string; subdomain?: string }) {
  const steps: string[] = [];
  const token = String(input.token ?? "").trim();
  const name = String(input.name ?? "").trim().toLowerCase();
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
    code = random(24);
    const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
    await q("DELETE FROM setup_codes");
    await q("INSERT INTO setup_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)", [await codeHash(code), new Date().toISOString(), expires]);
  }

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
          bindings: [
            { type: "d1", name: "DB", id: dbId },
            { type: "kv_namespace", name: "OAUTH_KV", namespace_id: kvId },
          ],
          observability: { enabled: true },
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
  const on = await cf(token, "POST", `${A}/workers/scripts/${name}/subdomain`, { enabled: true, previews_enabled: false });
  if (!on.a.success) throw new Stop(`Cloudflare wouldn't turn the address on: ${why(on.a)}.`);
  const url = `https://${name}.${subdomain}.workers.dev`;
  steps.push(`Address: ${url} (a new address can take a minute or two to answer).`);

  return { ok: true, url, setup: code ? `${url}/setup?code=${code}` : "", claimed, release: latest.version, steps };
}

const PAGE = (nonce: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Install Porchsite</title><style>
body{font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f2f2;color:#201e1d;margin:0}
.wrap{max-width:640px;margin:0 auto;padding:28px 18px 64px}h1{font-size:28px;margin:0 0 6px}h2{font-size:19px;margin:28px 0 6px}
.meta{color:#5c5855;font-size:15px}label{display:block;margin:14px 0 4px;font-weight:600}input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid #cfcbc9;border-radius:8px;background:#fff}
button,.button{display:inline-block;margin-top:16px;font:inherit;font-weight:600;padding:11px 18px;border:0;border-radius:8px;background:#00647f;color:#fff;text-decoration:none;cursor:pointer}
button[disabled]{opacity:.6}.card{background:#fff;border:1px solid #cfcbc9;border-radius:10px;padding:14px 16px;margin:12px 0}.error{color:#a8000f}ol li,ul li{margin:4px 0}code{background:#e9e6e4;padding:1px 5px;border-radius:4px}
</style></head><body><div class="wrap">
<h1>Install Porchsite</h1>
<p>A website your assistant keeps up to date, on your own free Cloudflare account. Nothing on it goes live without your yes.</p>
<h2>1. Make a Cloudflare token</h2>
<p>Sign in to Cloudflare (or make a free account), then open <a href="${esc(TOKEN_LINK)}" target="_blank" rel="noopener">this pre-filled token page</a>. Check it lists these, add any that are missing, and create the token:</p>
<ul>${PERMISSIONS.map((p) => `<li>${esc(p.label)}</li>`).join("")}</ul>
<p class="meta">The token goes to this installer only for the install, over HTTPS, and is never stored. When you're done you can delete it at Cloudflare; the site doesn't need it.</p>
<h2>2. Name it and install</h2>
<form id="f"><label for="name">The site's name (part of its address)</label><input id="name" name="name" required pattern="[a-z][a-z0-9-]{0,62}" placeholder="e.g. rams1976" autocomplete="off">
<label for="token">The token</label><input id="token" name="token" type="password" required autocomplete="off">
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
  const card = el("div", "", "card");
  if (r.steps && r.steps.length) { const ul = el("ul"); r.steps.forEach((s) => ul.append(el("li", s))); card.append(ul); }
  if (r.ok) {
    card.append(el("h2", "Your site is installed"));
    if (r.setup) {
      card.append(el("p", "Last step, yours: open your site's setup page and create your passkey. That passkey is how you approve everything from now on."));
      const a = el("a", "Claim your site", "button"); a.href = r.setup; a.target = "_blank"; a.rel = "noopener"; card.append(a);
      card.append(el("p", "The link works once, for 24 hours. If it says the page can't be reached, wait a minute: a brand-new address takes a moment.", "meta"));
    } else card.append(el("p", "It was already claimed; it now runs Porchsite " + r.release + ". Sign in at " + r.url + "/review."));
    card.append(el("p", "Then tell your assistant to connect to " + r.url + "/mcp. If its app can't, make it a key on your site's Assistants page."));
    f.hidden = true;
  } else {
    card.append(el("p", r.message || "Something went wrong.", "error"));
    extra.replaceChildren();
    if (r.need === "account") {
      extra.append(el("label", "Which account?"));
      const s = document.createElement("select"); s.name = "account";
      (r.accounts || []).forEach((a) => { const o = el("option", a.name); o.value = a.id; s.append(o); });
      extra.append(s);
    }
    if (r.need === "subdomain") {
      extra.append(el("label", "Your workers.dev name"));
      const i = document.createElement("input"); i.name = "subdomain"; i.required = true; i.placeholder = "e.g. sam"; extra.append(i);
    }
  }
  out.append(card);
});
</script></body></html>`;

/** /install/ and /install/run, or null for any other address. */
export async function installer(req: Request, env: Env): Promise<Response | null> {
  const u = new URL(req.url);
  if (u.pathname === "/install" || u.pathname === "/install/") {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const nonce = random(16);
    return new Response(PAGE(nonce), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
        "Referrer-Policy": "no-referrer",
      },
    });
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
