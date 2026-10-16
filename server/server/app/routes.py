"""Everything that isn't /mcp or the OAuth protocol endpoints: the public
site, and the owner's pages (setup, sign-in, review, connecting an
assistant). Owner pages are server-rendered; the only script is the passkey
call, under a nonce. Port of cloudflare/src/routes.ts, page for page.
"""

import json
import math
import re
from datetime import UTC, datetime
from zoneinfo import ZoneInfo
from typing import Any
from urllib.parse import quote, urlsplit

from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import Response

from server.spec import theme as views
from server.spec.embed_review import embed_review
from server.spec.embeds import PERMISSIONS, frame_csp
from server.spec.jsutil import long_date, string, u16slice
from server.spec.sitemap import SITEMAP_HEADERS, robots, sitemap

from . import privacy
from . import (
    analytics,
    approvals,
    builtin,
    changes,
    content,
    desk,
    history,
    importer,
    keys,
    media,
    oauth,
    old_addresses,
    owner,
    requests,
    sharecards,
    site,
    themes,
    updates,
    uploads,
    visibility,
)
from .db import Db
from .errors import ApiError
from .html import esc, nonce, redirect, respond
from .theme import BEACON_JS, feed, render, search_index, static_file

OWNER_CSS = (
    """
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
"""
    + "header>span{display:flex;flex-wrap:wrap;gap:6px 12px;max-width:100%}header>span a{margin-left:0}"
    + changes.CHANGES_CSS
)

SHRINK_JS = """
const form = document.querySelector("form"), input = form.querySelector("input[type=file]"), original = form.querySelector("input[name=original]"), btn = form.querySelector("button");
const MAX = 2400;
form.addEventListener("submit", async (e) => {
  const file = input.files[0];
  if (!file || original.checked || !window.createImageBitmap || !window.DataTransfer) return;
  e.preventDefault(); btn.disabled = true; btn.textContent = "Sending…";
  let image;
  try {
    image = await createImageBitmap(file);
    const scale = Math.min(1, MAX / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Picture resizing unavailable");
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.type !== "image/jpeg") throw new Error("Picture resizing unavailable");
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "photo.jpg", { type: "image/jpeg" }));
    input.files = transfer.files;
  } catch (error) {
    // Keep the selected file: the native form still works without a canvas.
  } finally {
    if (image) image.close();
    form.submit();
  }
});"""


class Context:
    """What the routes need: the database, the setup code, the OAuth provider,
    the address tokens are bound to (PORCHSITE_SITE_URL or the request's), and
    the release running (for the update notice)."""

    def __init__(
        self,
        db: Db,
        setup_code: str,
        provider: oauth.PgProvider,
        site_url: str = "",
        release: str = "dev",
    ):
        self.db = db
        self.setup_code = setup_code
        self.provider = provider
        self.site_url = site_url
        self.release = release


def origin_of(req: Request) -> str:
    u = req.url
    return f"{u.scheme}://{u.netloc}"


def _headers(*pairs: tuple[str, str]) -> list[tuple[bytes, bytes]]:
    return [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in pairs]


def _with_raw(resp: Response, pairs: list[tuple[str, str]]) -> Response:
    """Add headers that may repeat (Set-Cookie)."""
    resp.raw_headers.extend(_headers(*pairs))
    return resp


def owner_page(
    title: str,
    body: str,
    signed_in: bool = False,
    script: str = "",
    status: int = 200,
    headers: list[tuple[str, str]] | None = None,
) -> Response:
    n = nonce()
    nav = (
        '<span><a href="/review">Review</a><a href="/review/write">Write</a><a href="/review/stats">Stats</a><a href="/review/history">History</a><a href="/review/assistants">Assistants</a><a href="/review/passkeys">Passkeys</a><a href="/review/readers">Readers</a></span>'
        if signed_in
        else ""
    )
    page = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'<meta name="robots" content="noindex"><title>{esc(title)}</title><style>{OWNER_CSS}</style></head><body><div class="wrap">\n'
        f'<header><a href="/" style="margin:0">← Site</a>{nav}</header>\n'
        f"{body}</div>{f'<script nonce="{n}">{script}</script>' if script else ''}</body></html>"
    )
    plain = {"Cache-Control": "no-store", "X-Frame-Options": "DENY"}
    extra = [(k, v) for k, v in headers or [] if k.lower() != "set-cookie"]
    plain.update(dict(extra))
    resp = respond(
        page,
        status=status,
        headers=plain,
        csp=f"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-{n}'; connect-src 'self'; img-src 'self' https:; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
    )
    cookies = [(k, v) for k, v in headers or [] if k.lower() == "set-cookie"]
    # Analytics never counts a browser the owner is signed in on.
    if signed_in:
        cookies.append(("Set-Cookie", analytics.NOTRACK_SET))
    return _with_raw(resp, cookies)


def signed_in_json(cookie: str) -> Response:
    """A sign-in's answer also marks the browser as not counted by analytics."""
    return json_response(
        {"ok": True, "reader": cookie.startswith(owner.READER_COOKIE + "=")}, headers=[("Set-Cookie", cookie), ("Set-Cookie", analytics.NOTRACK_SET)]
    )


def passkey_js(kind: str, next: str, base: str | None = None) -> str:
    """The passkey ceremony: JSON in, JSON out, then go to `next`."""
    base = base or kind
    cred = (
        "await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(j.options) })"
        if kind != "login"
        else "await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(j.options) })"
    )
    return f"""
const form = document.querySelector("form"), err = document.querySelector(".error");
form.addEventListener("submit", async (e) => {{
  e.preventDefault(); err.hidden = true;
  const say = (m) => {{ err.textContent = m; err.hidden = false; }};
  try {{
    if (!window.PublicKeyCredential || !PublicKeyCredential.parseRequestOptionsFromJSON) return say("This browser can't use passkeys. Try an up-to-date Safari, Chrome or Firefox.");
    const body = Object.fromEntries(new FormData(form));
    const r = await fetch("/{base}/options", {{ method: "POST", headers: {{ "content-type": "application/json" }}, body: JSON.stringify(body) }});
    const j = await r.json(); if (!r.ok) return say(j.message);
    const cred = {cred};
    const v = await fetch("/{base}/verify", {{ method: "POST", headers: {{ "content-type": "application/json" }}, body: JSON.stringify(cred.toJSON()) }});
    const k = await v.json(); if (!v.ok) return say(k.message);
    if (k.reader) location.href = "/"; else location.href = {json.dumps(next)};
  }} catch (x) {{ say(x && x.name === "NotAllowedError" ? "Cancelled. Try again when you're ready." : String(x)); }}
}});"""


def json_response(
    v: Any, status: int = 200, headers: list[tuple[str, str]] | None = None
) -> Response:
    resp = Response(
        json.dumps(v, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        status_code=status,
        headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
    )
    return _with_raw(resp, headers or [])


# Where to go after signing in: one of the owner's own pages, with any query
# (a connect request's carries plain ":" and "/"; its own address must
# survive). A single leading "/" keeps it on this site; only plain URL
# characters (no quotes, angle brackets or backslash: it goes into a script).
_NEXT = re.compile(r"^/(review|authorize)([/?][A-Za-z0-9/_?=&%.:~+,;!*()@$-]*)?\Z")


def safe_next(next: str | None) -> str:
    return next if next and _NEXT.search(next) else "/review"


def _search(req: Request) -> str:
    q = req.scope.get("query_string", b"").decode("latin-1")
    return f"?{q}" if q else ""


def _path(req: Request) -> str:
    raw = req.scope.get("raw_path")
    return raw.decode("latin-1") if raw else req.url.path


def encode_uri_component(s: str) -> str:
    return quote(s, safe="-_.!~*'()")


async def require_owner(req: Request, cx: Context) -> Response | None:
    if await owner.signed_in(cx.db, req):
        return None
    if await owner.reader_signed_in(cx.db,req):
        return redirect("/",303)
    o = origin_of(req)
    if not await owner.has_owner(cx.db):
        return redirect(f"{o}/setup", 303)
    return redirect(f"{o}/login?next={encode_uri_component(_path(req) + _search(req))}", 303)


async def _form(req: Request) -> Any:
    try:
        return await req.form()
    except Exception:
        return {}


def _field(form: Any, name: str) -> str:
    v = form.get(name) if form else None
    return "" if v is None or isinstance(v, UploadFile) else str(v)


# --- owner: claim, sign in ---------------------------------------------------------------


# /setup may carry the code in its address (/setup?code=...): never send it on
# as a referrer, never keep it in a cache, and take it out of the address bar.
SETUP_HEADERS = [("Referrer-Policy", "no-referrer"), ("Cache-Control", "no-store")]
SETUP_JS = 'if (location.search) history.replaceState(null, "", location.pathname);\n'


async def setup_page(req: Request, cx: Context) -> Response:
    if await owner.has_owner(cx.db):
        return redirect(f"{origin_of(req)}/login", 303, headers=dict(SETUP_HEADERS))
    code = u16slice((req.query_params.get("code") or "").strip(), 0, 200)
    intro = (
        "Your setup code is filled in. Add your name if you like, then create a passkey."
        if code
        else "Enter the setup code you were given, then create a passkey."
        " No code? If the site was installed at get.porchsite.dev/install/, run it again with the same name and token: it keeps everything and gives you a new claim link. Otherwise, ask whoever set it up."
    )
    return owner_page(
        "Set up your site",
        f"""<h1>Make this site yours</h1><p class="meta">{esc(origin_of(req).split("://", 1)[-1])}</p><p>{intro} From then on, your passkey is the only way to approve what goes live.</p>
<form><label>Setup code</label><input type="password" name="code" autocomplete="off" required{f' value="{esc(code)}"' if code else ""}><label>Your name (optional: your passkey is saved under it, next to this site&#39;s address)</label><input type="text" name="name" autocomplete="name" maxlength="80">
<p class="error" hidden></p><button>Create my passkey</button></form>""",
        script=SETUP_JS + passkey_js("setup", "/review"),
        headers=SETUP_HEADERS,
    )


async def login_page(req: Request, cx: Context) -> Response:
    if not await owner.has_owner(cx.db):
        return redirect(f"{origin_of(req)}/setup", 303)
    nxt = safe_next(req.query_params.get("next"))
    return owner_page(
        "Sign in",
        '<h1>Sign in</h1><p>Use your passkey.</p><form><p class="error" hidden></p><button>Sign in with passkey</button></form>',
        script=passkey_js("login", nxt),
    )


# --- themes ------------------------------------------------------------------------------

THEME_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"


def themed_html(body: str, status: int = 200, sources=None, origin="") -> Response:
    """Pages always check back, so an approved change is live for everyone at
    once; a miss is never stored, so a page published a moment later can't
    hide behind it."""
    return respond(
        body,
        status=status,
        headers={"Cache-Control": "no-store" if status == 404 else "no-cache", "Permissions-Policy": PERMISSIONS},
        csp=frame_csp(THEME_CSP, sources, origin),
    )


def _file(f: dict[str, Any] | None) -> Response | None:
    if f is None:
        return None
    body = f["body"]
    return Response(body.encode("utf-8") if isinstance(body, str) else body, headers=f["headers"])


_PUBLIC = re.compile(
    r"^/[a-z][a-z0-9-]{0,29}/((tags/[a-z0-9-]{1,30}/)|search\.json|feed\.xml|[a-z0-9-]{1,80}/)?\Z"
)
_OLD = re.compile(r"^/e/([a-z0-9-]+)/?\Z")
_FEED = re.compile(r"^/([a-z][a-z0-9-]{0,29})/feed\.xml\Z")
_STATIC = re.compile(r"^/static/([a-z0-9._-]+)\Z")
_SEARCH = re.compile(r"^/([a-z][a-z0-9-]{0,29})/search\.json\Z")
_ARCH = re.compile(r"^/([a-z][a-z0-9-]{0,29})/(?:tags/([a-z0-9-]{1,30})/)?\Z")


async def themed_page(req: Request, cx: Context, path: str) -> Response | None:
    """Public pages through the site's theme, or None for the built-in look."""
    is_public = path == "/" or re.match(r"^/(e|static)/", path) or _PUBLIC.search(path)
    if not is_public:
        return None
    v = await content_view(req,cx)
    origin = origin_of(req)
    policy = {"sources": v.site.get("embed_sources"), "origin": origin}
    def page(body):
        return themed_html(body, sources=policy["sources"], origin=origin)
    # Entry addresses before streams had paths: /e/<slug>/ moves to the entry's own.
    old = _OLD.search(path)
    if old:
        moved = next((x for x in v.entries if x["slug"] == old.group(1)), None)
        if moved:
            return redirect(moved.get("external_url") or moved["page"], 301)
    # Feeds are the site's own, whatever its look.
    atom = _FEED.search(path)
    if atom:
        return _file(feed(v, atom.group(1), origin))
    t = await themes.load(cx.db, str(v.site["theme"]))
    if not t:
        return None
    release = site.release_of(v)
    st = _STATIC.search(path)
    if st:
        return _file(static_file(t, st.group(1), string(v.site.get("palette") or "")))
    if path == "/":
        return page(render(t, "home", views.home_view(v, release, origin), policy))
    e = next((x for x in v.entries if x["page"] == path), None)
    if e and e.get("external_url"):
        return redirect(e["external_url"], 302)
    if e:
        return page(render(t, "entry", views.entry_view(v, e, release, origin), policy))
    search = _SEARCH.search(path)
    if search:
        return _file(search_index(v, search.group(1)))
    arch = _ARCH.search(path)
    if arch:
        av = views.archive_view(v, arch.group(1), release, origin, arch.group(2))
        if av:
            return page(render(t, "tag" if arch.group(2) else "archive", av, policy))
    return None


async def content_view(req, cx, discovery=False):
    await privacy.require_content(cx.db,req)
    return await site.live_view(cx.db,discovery=discovery)


async def not_found_page(req: Request, cx: Context) -> Response:
    """The 404 page, in the site's theme when it has one."""
    v = await content_view(req,cx)
    path = _path(req)
    to = (
        builtin.redirect_for(v, path)
        or await content.moved_address(cx.db, v.entries, v.site["streams"], path)
        if req.method == "GET"
        else None
    )
    # An hour, not forever: a browser keeps a bare 301 for good, and a stream can move again.
    if to:
        return redirect(to + _search(req), 301, {"Cache-Control": "max-age=3600"})
    # A server-edition extra (SPEC §9): an image's address on the older engine.
    old = await old_addresses.lookup(cx.db, path) if req.method == "GET" else None
    if old:
        return redirect(old, 301, {"Cache-Control": "max-age=86400"})
    t = await themes.load(cx.db, str(v.site["theme"]))
    if not t:
        return builtin.not_found(v, origin_of(req))
    release = site.release_of(v)
    return themed_html(
        render(t, "not_found", views.not_found_view(v, release, origin_of(req)), {"sources":v.site.get("embed_sources"),"origin":origin_of(req)}), 404, sources=v.site.get("embed_sources"), origin=origin_of(req)
    )


# --- the person's phone: a one-time photo upload --------------------------------------------


def _upload_shut() -> Response:
    return owner_page(
        "Link used",
        "<h1>This link has been used or has expired</h1><p>Ask your assistant for a new one.</p>",
        status=410,
    )


async def upload_page(req: Request, cx: Context, token: str) -> Response:
    if req.method == "POST":
        # An assistant sending the file itself asks for JSON and gets the result
        # in the answer; the person's browser gets a page.
        wants_json = "application/json" in (req.headers.get("accept") or "")
        form = await _form(req)
        file = form.get("photo") if form else None
        try:
            if not form or len(form.getlist("photo")) != 1 or sum(isinstance(v, UploadFile) for _, v in form.multi_items()) != 1:
                raise ApiError(422, "invalid", "Choose exactly one photo.")
            data = await file.read() if isinstance(file, UploadFile) else None
            done = await uploads.receive(cx.db, token, data, _field(form, "alt"))
            if wants_json:
                return json_response(done)
        except ApiError as e:
            if wants_json:
                return json_response(e.to_json(), e.status)
            if e.code == "link_used":
                return _upload_shut()
            u = await uploads.open(cx.db, token)
            return upload_form(u, e.message) if u else _upload_shut()
        return owner_page(
            "Sent",
            "<h1>Got it, thank you</h1><p>Your assistant can use the photo now. Nothing shows on your site until you approve it.</p>",
        )
    u = await uploads.open(cx.db, token)
    return upload_form(u, "") if u else _upload_shut()


def upload_form(u: dict[str, Any], error: str) -> Response:
    purpose = f"<p>For: {esc(u['purpose'])}</p>" if u.get("purpose") else ""
    err = f'<p class="error">{esc(error)}</p>' if error else ""
    return owner_page(
        "Add a photo",
        f"""<h1>Add a photo</h1>{purpose}{err}
<form method="post" enctype="multipart/form-data"><label>Photo</label><input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required>
<label>What it shows, in a few words (for people who can't see it)</label><input type="text" name="alt" maxlength="200" required>
<label><input type="checkbox" name="original" style="width:auto"> Keep the original size</label>
<p class="meta">Bigger files use more of the free plan's limits, make pages slower and take more storage.</p>
<p class="meta">By default, this browser makes a web-size JPEG, at most 2400 pixels on the long side. If it cannot resize the picture, the original file is sent instead.</p>
<button>Upload</button></form><p class="meta">This link works once and stops at {esc(u["expires_at"][11:16])} UTC.</p>""",
        script=SHRINK_JS,
    )


# --- owner: review ----------------------------------------------------------------------------


def _unsent_line(n: int) -> str:
    if not n:
        return ""
    what = "There is 1 change" if n == 1 else f"There are {n} changes"
    return f'<p class="meta">{what} not yet sent to you for review. Nothing goes live until you approve it.</p>'


async def import_page(req: Request, error: str = "", problems: list[str] | None = None) -> Response:
    errs = f'<p class="error">{esc(error)}</p>' if error else ""
    listed = (
        '<ul class="meta">' + "".join(f"<li>{esc(p)}</li>" for p in problems) + "</ul>"
        if problems
        else ""
    )
    return owner_page(
        "Import",
        f"""<h1>Import from an assistant</h1><p>For an assistant that can&#39;t reach your site: it gives you one file, and you upload it here. Everything in it is checked like any draft and waits for your approval; nothing goes live from here.</p>{errs}{listed}
<form method="post" enctype="multipart/form-data"><input type="hidden" name="csrf" value="{esc(owner.csrf(req))}"><label>The file (.json)</label><input type="file" name="file" accept=".json,application/json" required><button>Import and review</button></form>""",
        signed_in=True,
        status=422 if error else 200,
    )


_CARD = re.compile(r"^/review/cards/([a-z]{2,8}_[0-9a-f]{4,40})\Z")


async def review_index(req: Request, cx: Context) -> Response:
    every = await approvals.list(cx.db)
    open_ = [a for a in every if any(i["status"] == "pending" for i in a["items"])]
    done = [a for a in every if not any(i["status"] == "pending" for i in a["items"])][:20]

    def row(a: dict[str, Any]) -> str:
        items = "".join(
            f'<h2>{esc(i["label"])}</h2><div class="meta">{esc(i["kind"])} · {esc(i["change"])} · {esc(i["status"].replace("_", " ", 1))}</div>'
            for i in a["items"]
        )
        go = (
            "Review and decide →"
            if any(i["status"] == "pending" for i in a["items"])
            else "See details →"
        )
        when = a["created_at"][:16].replace("T", " ", 1)
        return (
            f'<a class="card" href="/review/{esc(a["id"])}"><div class="meta">{esc(a["requested_by"])} · {esc(when)} UTC</div>'
            f'{items}<span class="go">{go}</span></a>'
        )

    waiting = "".join(row(a) for a in open_) if open_ else '<p class="meta">Nothing is waiting.</p>'
    decided = "".join(row(a) for a in done) if done else '<p class="meta">Nothing yet.</p>'
    return owner_page(
        "Review",
        f"""{updates.notice_html(await updates.check(cx.db, cx.release))}<h1>Waiting for you</h1>{_unsent_line(await approvals.unsent(cx.db))}{waiting}
<h1 style="margin-top:36px">Decided</h1>{decided}
<form method="post" action="/logout"><input type="hidden" name="csrf" value="{esc(owner.csrf(req))}"><button class="ghost">Sign out</button></form>
<p class="meta" style="margin-top:32px">An assistant gave you a file? <a href="/review/import">Import it</a>.</p>
<div id="share-cards" hidden data-csrf="{esc(owner.csrf(req))}"></div>""",
        signed_in=True,
        script=sharecards.CARD_JS,
    )


KIND_WORD = {"site": "your site's text and look", "entry": "page", "card": "card", "note": "note"}


def _page_of(streams: list[dict[str, Any]], stream: Any, slug: str) -> str:
    s = next((x for x in streams if x["id"] == stream), streams[0])
    return f"/{s.get('path') or s['id']}/{slug}/"


# The review and revert pages: a decision says it's working, and can't be
# sent twice (cloudflare/src/routes.ts BUSY_JS, the same bytes).
BUSY_JS = """// A big decision can take seconds: say so, and stop a second press.
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
"""


def _busy_word(n: int, what: str) -> str:
    return f"{what} {n} change{'' if n == 1 else 's'}… This can take a few seconds; keep this page open."


async def review_show(req: Request, cx: Context, id: str, error: str = "") -> Response:
    a = await approvals.get(cx.db, id)
    blocks = []
    embed_changes = []
    for it in a["items"]:
        item = await content.get_item(cx.db, it["id"])
        live = await cx.db.fetchrow("SELECT data, slug FROM live WHERE item_id = $1", it["id"])
        rev = await cx.db.fetchrow(
            "SELECT data, deleted FROM revisions WHERE item_id = $1 AND version = $2",
            it["id"],
            it["version"],
        )
        shown = await content.source_data(cx.db, it["id"], it["version"], json.loads(rev["data"])) if rev else item["data"]
        if live and it["kind"] == "site":
            live = {**dict(live), "data": json.dumps(await content.site_data(cx.db, True))}
        if it["status"] == "pending":
            embed_changes.append({"id":it["id"],"kind":it["kind"],"data":shown,"deleted":bool(rev["deleted"]) if rev else item["deleted"]})
        # An entry whose address changes says so: the old one will send visitors on.
        moves: list[str] = []
        if it["kind"] == "entry" and it["change"] == "changed" and live and live["slug"] and item["slug"]:  # fmt: skip
            streams = (await content.site_data(cx.db, True))["streams"]
            old = _page_of(streams, json.loads(live["data"]).get("stream"), live["slug"])
            new = _page_of(streams, shown.get("stream"), item["slug"])
            if old != new:
                moves.append(changes.address_row(old, new))
        if it["kind"] == "site":
            what = (
                "Your site's text and look"
                if it["change"] == "new"
                else "Changes to your site's text and look"
            )
        else:
            verb = (
                "New"
                if it["change"] == "new"
                else "Removing the"
                if it["change"] == "removed"
                else "Changed"
            )
            what = f"{verb} {KIND_WORD.get(it['kind'], it['kind'])}: {it['label']}"
        status = (
            ""
            if it["status"] == "pending"
            else f'<span class="tag">{esc(it["status"].replace("_", " ", 1))}</span>'
        )
        if it["change"] == "removed":
            says = changes.taken_off(it["label"])
        elif live:
            says = changes.what_changed(it["kind"], shown, json.loads(live["data"]), moves)
        else:
            says = changes.what_it_says(it["kind"], shown, it["kind"] != "site")
        note = f'<p class="meta">Your note: {esc(it["note"])}</p>' if it.get("note") else ""
        see = ""
        if it["status"] == "published" and it["change"] != "removed":
            href = f"/e/{item['slug']}/" if item["kind"] == "entry" and item["slug"] else "/"
            see = f'<p><a href="{esc(href)}">See it on the site →</a></p>'
        choose = ""
        if it["status"] == "pending":
            i = esc(it["id"])
            choose = f"""<details class="one"><summary class="meta" style="cursor:pointer">Decide this one separately</summary><fieldset class="choice" style="border:0;padding:0;margin-top:10px"><label><input type="radio" name="d_{i}" value="approve" checked> Publish it</label>
<label><input type="radio" name="d_{i}" value="changes"> Ask for changes</label><label><input type="radio" name="d_{i}" value="deny"> No, leave it out</label>
<label><input type="radio" name="d_{i}" value="later"> Decide later</label></fieldset><label>Note to your assistant (optional)</label><textarea name="n_{i}" rows="2"></textarea></details>"""
        blocks.append(
            f'<div class="card">{status}<h2 style="margin-top:4px">{esc(what)}</h2>\n{says}\n{note}\n{see}\n{choose}</div>'
        )
    waiting = [i for i in a["items"] if i["status"] == "pending"]
    pending = bool(waiting)
    who = re.sub(r"^assistant:", "", a["requested_by"]) or "Your assistant"
    count = len(waiting)

    def n(c: str) -> int:
        return sum(1 for i in waiting if i["change"] == c)

    parts = [p for p in (n("new") and f"add {n('new')}", n("changed") and f"change {n('changed')}", n("removed") and f"remove {n('removed')}") if p]  # fmt: skip
    sentence = (
        f"{who} wants to {re.sub(r', ([^,]*)$', r' and \1', ', '.join(parts), count=1)} thing{'' if count == 1 else 's'} on your site."
        if parts
        else ""
    )
    raised = await visibility.raises(cx.db, waiting)
    embed_warn = await _embed_review_for(cx.db, embed_changes, origin_of(req))
    embed_warn += await _private_review_warning(cx.db, embed_changes)
    warn = "".join(f'<p class="warn">{esc(raise_line(r))}</p>' for r in raised)
    heading = (
        f"{esc(who)} has {count} change{'' if count == 1 else 's'} for your site"
        if pending
        else "Decided"
    )
    look = (
        f'<p>{esc(sentence)} Nothing changes until you approve. Look first:</p><p><a class="button" href="/review/{esc(a["id"])}/preview">See the site as it will look</a></p>'
        if pending
        else ""
    )
    big = (
        f"""<button name="all" value="approve" data-busy="{esc(_busy_word(count, "Publishing"))}">Approve and publish</button>
<details id="changes" style="margin-top:12px"><summary class="meta" style="cursor:pointer">Ask for changes instead</summary><label>What should your assistant change?</label><textarea name="note_all" rows="3"></textarea><button class="ghost" name="all" value="changes" data-busy="Sending your note to your assistant…">Send back for changes</button></details>
<h2 style="margin-top:28px">What's in it</h2>"""
        if pending
        else ""
    )
    save = (
        '<button class="ghost" name="all" value="each" data-busy="Saving your choices…">Save my separate choices</button>'
        if pending
        else ""
    )
    return owner_page(
        "Review changes",
        f"""{updates.notice_html(await updates.check(cx.db, cx.release))}<h1>{heading}</h1>{f"<p>{esc(a['note'])}</p>" if a.get("note") else ""}{f'<p class="error">{esc(error)}</p>' if error else ""}
{embed_warn}{warn}
{look}
<form method="post"><input type="hidden" name="csrf" value="{esc(owner.csrf(req))}">
{big}{"".join(blocks)}{save}</form>""",
        signed_in=True,
        script=BUSY_JS,
    )


VIS_WORD = {
    "private": "private (not shown)",
    "mention": "a mention (name and description only)",
    "public": "public (the whole card)",
}


def raise_line(r: dict[str, str]) -> str:
    """A card this change shows more of than the live site does."""
    return f'Shows more: the card "{r["name"]}" goes from {VIS_WORD.get(r["from"], r["from"])} to {VIS_WORD.get(r["to"], r["to"])}.'


async def review_decide(req: Request, cx: Context, id: str) -> Response:
    form = await _form(req)
    if _field(form, "csrf") != owner.csrf(req):
        return await review_show(req, cx, id, "This form expired. Try again.")
    decisions: dict[str, dict[str, Any]] = {}
    every = _field(form, "all") or "each"
    if every in ("approve", "changes"):
        # One answer for everything waiting: the big buttons.
        note = _field(form, "note_all")
        if every == "changes" and not note.strip():
            return await review_show(
                req, cx, id, "Say what should change, so your assistant knows what to do."
            )
        for i in (await approvals.get(cx.db, id))["items"]:
            if i["status"] == "pending":
                decisions[i["id"]] = {"decision": every, "note": note}
    else:
        for k, v in form.multi_items() if hasattr(form, "multi_items") else []:
            if k.startswith("d_"):
                item_id = k[2:]
                decisions[item_id] = {"decision": str(v), "note": _field(form, f"n_{item_id}")}
    try:
        await approvals.decide(cx.db, id, decisions, "", origin_of(req))
    except ApiError as e:
        return await review_show(req, cx, id, e.message)
    origin = origin_of(req)
    if every == "approve":
        shown = re.sub(r"^https://", "", origin)
        return owner_page(
            "Live",
            f'<h1>Your site is updated</h1><p>The changes are live now at <a href="/">{esc(shown)}</a>.</p><p><a class="button" href="/">See your site</a></p><p><a href="/review">Back to your reviews</a></p>'
            f'<div id="share-cards" hidden data-csrf="{esc(owner.csrf(req))}"></div>',
            signed_in=True,
            script=sharecards.CARD_JS,
        )
    if every == "changes":
        return owner_page(
            "Sent back",
            '<h1>Your assistant has been told</h1><p>Nothing changed on your site. Your assistant will see your note and send you the changes to look at again.</p><p><a href="/review">Back to your reviews</a></p>',
            signed_in=True,
        )
    return redirect(f"{origin}/review/{id}", 303)


# --- connecting an assistant (OAuth consent) ------------------------------------------------


def oauth_error(error: Exception, status: int = 400) -> Response:
    if isinstance(error, oauth.AuthorizationError) and error.redirect_uri:
        params = {"error": error.code, "error_description": error.description}
        if error.state:
            params["state"] = error.state
        if error.issuer:
            params["iss"] = error.issuer
        return redirect(oauth.with_params(error.redirect_uri, params), 302)
    if isinstance(error, oauth.AuthorizationError | oauth.CimdFetchError):
        message = (
            error.description
            if isinstance(error, oauth.AuthorizationError)
            else "This app could not be verified."
        )
        return owner_page(
            "Can't connect", f"<h1>Can't connect</h1><p>{esc(message)}</p>", status=status
        )
    raise error


def _issuer(req: Request, cx: Context) -> str:
    return cx.site_url or origin_of(req)


async def authorize_get(req: Request, cx: Context) -> Response:
    # Connecting before the claim would leave the app with a broken connector:
    # say so, rather than sending them to the setup form.
    if not await owner.has_owner(cx.db):
        return owner_page(
            "Not claimed yet",
            "<h1>Not claimed yet</h1><p>This site hasn&#39;t been claimed by its owner yet, so no assistant can connect to it. Claim it first, with the claim link from the installer (or the setup link your assistant gave you). Then connect again: remove this connector and add it anew, so your app picks up the site&#39;s tools.</p>",
            status=409,
        )
    gate = await require_owner(req, cx)
    if gate:
        return gate
    try:
        issuer = _issuer(req, cx)
        ar = await oauth.parse_auth_request(cx.provider, req, issuer, oauth.resource_of(issuer))
        client = await cx.provider.get_client(ar["clientId"])
        if not client:
            return owner_page("Can't connect", "<h1>Unknown app</h1>", status=400)
        handle, headers = await oauth.begin_consent(cx.db, ar)
        name = client.client_name or client.client_id
        host = urlsplit(ar["redirectUri"]).hostname or ""
        local = re.match(r"^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)\Z", host)
        verified = (
            f"Published by <strong>{esc(urlsplit(client.client_id).hostname)}</strong>."
            if client.client_id.startswith("https://")
            else "This app named itself; the name isn't verified."
        )
        warn = (
            '<p class="error">This sends access to an app on a computer. Continue only if you just started connecting from it.</p>'
            if local
            else ""
        )
        shown_host = f"[{host}]" if ":" in host else host
        return owner_page(
            "Connect an assistant",
            f"""<h1>Let {esc(name)} work on your site?</h1><p>{verified} Access goes to <strong>{esc(shown_host)}</strong>.</p>
{warn}
<div class="card"><p style="margin:0">It will be able to <b>read your site and draft changes</b>. It <b>can't publish</b>: every change waits for you here.</p></div>
<form method="post"><input type="hidden" name="handle" value="{esc(handle)}">
<label>Call it</label><input type="text" name="label" value="{esc(name)}" maxlength="40" autocomplete="off">
<p class="meta">This is the name you'll see on its requests. Apps sometimes register under their vendor's name.</p>
<button name="decision" value="approve">Allow</button>
<button class="ghost" name="decision" value="deny">Don't allow</button></form>""",
            signed_in=True,
            headers=list(headers.items()),
        )
    except (oauth.AuthorizationError, oauth.CimdFetchError) as e:
        return oauth_error(e)


async def authorize_post(req: Request, cx: Context) -> Response:
    gate = await require_owner(req, cx)
    if gate:
        return gate
    try:
        form = await _form(req)
        handle = _field(form, "handle")
        if _field(form, "decision") != "approve":
            to = await oauth.deny_consent(cx.db, req, handle)
            return _with_raw(
                redirect(to, 302, {"Cache-Control": "no-store"}),
                [("Set-Cookie", oauth.CLEAR_CONSENT)],
            )
        ar = await oauth.approve_consent(cx.db, req, handle)
        client = await cx.provider.get_client(ar["clientId"])
        label = u16slice(_field(form, "label").strip(), 0, 40)
        name = u16slice(label or (client.client_name if client else None) or ar["clientId"], 0, 80)
        to = await oauth.complete_authorization(
            cx.db,
            ar,
            "owner",
            {"client": name},
            ar["scope"],
            {"client": name, "clientId": ar["clientId"], "origin": origin_of(req)},
        )
        return _with_raw(
            redirect(to, 302, {"Cache-Control": "no-store"}), [("Set-Cookie", oauth.CLEAR_CONSENT)]
        )
    except (oauth.AuthorizationError, oauth.CimdFetchError) as e:
        return oauth_error(e)


async def assistants_page(
    req: Request, cx: Context, revoke: str | None = None, made: dict[str, str] | None = None
) -> Response:
    if revoke:
        await oauth.revoke_grant(cx.db, revoke, "owner")
    items = await oauth.list_user_grants(cx.db, "owner")
    token = owner.csrf(req)
    mcp_url = f"{origin_of(req)}/mcp"
    if items:
        body = "".join(
            f"""<div class="card"><h2>{esc((g["metadata"] or {}).get("client") or g["clientId"])}</h2><div class="meta">since {datetime.fromtimestamp(g["createdAt"], UTC).date().isoformat()}</div>
<form method="post"><input type="hidden" name="csrf" value="{esc(token)}"><input type="hidden" name="revoke" value="{esc(g["id"])}"><button class="ghost">Disconnect</button></form></div>"""
            for g in items
        )
    else:
        body = f'<p class="meta">None yet. In your assistant, add a connector with this address: <b>{esc(mcp_url)}</b></p>'
    shown = (
        f'<div class="card"><h2>Key for {esc(made["name"])}</h2><p class="value"><b>{esc(made["token"])}</b></p><p>Put it in your assistant&#39;s app, in its field for secrets, API keys or connector credentials. <b>Never paste it into a chat</b>, even if your assistant asks: anyone who reads the chat could use it. If you did, revoke it below and make a new one.</p><p class="meta">Copy it now: it isn&#39;t shown again. Works until {esc(made["expires_at"][:10])}.</p></div>'
        if made
        else ""
    )
    listed = "".join(
        f"""<div class="card"><h2>{esc(k["name"])}</h2><div class="meta">made {esc(k["created_at"][:10])} · works until {esc(k["expires_at"][:10])} · {esc("last used " + k["last_used_at"][:10]) if k["last_used_at"] else "not used yet"}</div>
<form method="post"><input type="hidden" name="csrf" value="{esc(token)}"><input type="hidden" name="revoke_key" value="{esc(k["id"])}"><button class="ghost">Revoke</button></form></div>"""
        for k in await keys.list(cx.db)
    )
    return owner_page(
        "Assistants",
        f"""<h1>Connected assistants</h1><p>Each can read your site and draft changes. None can publish.</p>{body}
<h1 style="margin-top:36px">Assistant keys</h1>
<p>For an assistant whose app can&#39;t add a connector with sign-in. Make a key, then put it in the assistant&#39;s secret or API-key field, never in a chat. It reaches the same tools at <b>{esc(mcp_url)}</b> as <code>Authorization: Bearer</code> and the key. Like any assistant, it can only draft: everything waits for you here. A key stops working after {keys.KEY_DAYS} days, or when you revoke it.</p>
{shown}
{listed}
<form method="post"><input type="hidden" name="csrf" value="{esc(token)}"><label>Which assistant is it for?</label><input type="text" name="key_name" maxlength="40" required placeholder="e.g. Muse"><button name="make_key" value="1">Make a key</button></form>""",
        signed_in=True,
    )


# --- owner: the site as it will look --------------------------------------------------------


async def review_preview(req: Request, cx: Context, id: str, path: str = "/") -> Response:
    """The site with this approval's items published on top of what's live, in
    the theme it would have: every page, with its links kept inside the preview."""
    a = await approvals.get(cx.db, id)
    origin = origin_of(req)
    body = await site.preview_page(cx.db, id, origin, path)
    if body == "":
        return await not_found_page(req, cx)
    if body is None:
        v = await site.proposed_view(
            cx.db,
            [
                {"id": i["id"], "version": i["version"]}
                for i in a["items"]
                if i["status"] in ("pending", "published")
            ],
        )
        page = builtin.home(v) if path == "/" else builtin.entry_page(v, path)
        if page is None:
            return await not_found_page(req, cx)
        body = page.body.decode("utf-8")
    base = f"/review/{a['id']}/preview"
    body = re.sub(
        r'(href=")/(?!/|static/|media/|review/)([^"]*")',
        lambda m: f"{m.group(1)}{base}/{m.group(2)}",
        body,
    )
    pending = any(i["status"] == "pending" for i in a["items"])
    raised = await visibility.raises(cx.db, [i for i in a["items"] if i["status"] == "pending"])
    shows = "".join(
        f'<span style="flex-basis:100%;color:#f3d9a4">{esc(raise_line(r))}</span>' for r in raised
    )
    csrf = owner.csrf(req)
    btn = "font:600 15px/1 -apple-system,sans-serif;border-radius:6px;padding:12px 16px;border:0;cursor:pointer"
    # A bar across the top says what this is, with the decision right there; nothing here is public.
    decide = (
        f'<a style="{btn};background:transparent;color:#fff;border:1px solid #fff;text-decoration:none" href="/review/{a["id"]}#changes">Ask for changes</a><form method="post" action="/review/{a["id"]}" style="margin:0"><input type="hidden" name="csrf" value="{csrf}"><button name="all" value="approve" style="{btn};background:#9fd8c4;color:#1c1f1d">Approve and publish</button></form>'
        if pending
        else ""
    )
    bar = f"""<div style="position:sticky;top:0;z-index:99;background:#1c1f1d;color:#fff;font:15px/1.4 -apple-system,sans-serif;padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
<span>Preview: nothing is live yet.</span>{shows}<span style="display:flex;gap:8px;flex-wrap:wrap">
<a style="{btn};background:#fff;color:#1c1f1d;text-decoration:none" href="/review/{a["id"]}">Back</a>{decide}</span></div>"""
    page = re.sub(r"<body([^>]*)>", lambda m: f"<body{m.group(1)}>{bar}", body, count=1)
    return respond(
        page,
        headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"},
        csp=THEME_CSP.replace("form-action 'none'", "form-action 'self'"),
    )


# --- owner: more passkeys ------------------------------------------------------------------


async def passkeys_page(req: Request, cx: Context, made: dict[str, str] | None = None) -> Response:
    n = await owner.passkey_count(cx.db)
    here = origin_of(req)
    if made:
        part = f"""<div class="card"><h2>Your link</h2><p>Open it on the device, or at the address, where you want the new passkey. Swap the start of the link for the new address if the site is moving (for example <b>https://example.com</b>). It works once, until {esc(made["expires_at"][11:16])} UTC.</p><p class="value"><b>{esc(here)}/passkey/{esc(made["token"])}</b></p></div>"""
    else:
        part = f'<form method="post"><input type="hidden" name="csrf" value="{esc(owner.csrf(req))}"><button>Make a link to add a passkey</button></form>'
    return owner_page(
        "Passkeys",
        f"""<h1>Passkeys</h1><p>You have {n} passkey{"" if n == 1 else "s"} for this site. A passkey works only on the device and the address where it was made, so add one for each phone or computer you approve from, and again if the site moves to a new address.</p>
{part}""",
        signed_in=True,
    )


async def add_passkey_page(cx: Context, token: str) -> Response:
    if not await owner.passkey_link_open(cx.db, token):
        return owner_page(
            "Link used",
            "<h1>This link has been used or has expired</h1><p>Make a new one on the Passkeys page where you're signed in.</p>",
            status=410,
        )
    return owner_page(
        "Add a passkey",
        """<h1>Add a passkey here</h1><p>This saves a new passkey for this site on this device, at this address. Your other passkeys keep working.</p>
<form><p class="error" hidden></p><button>Create my passkey</button></form>""",
        script=passkey_js("add", "/review", f"passkey/{token}"),
    )


# --- owner: who reads the site ---------------------------------------------------------------

RANGES = [("1", "Today"), ("7", "7 days"), ("30", "30 days"), ("90", "90 days")]
SOURCE_WORD = {"x": "X", "search": "Search", "direct": "Direct or app", "other": "Other sites", "internal": "Inside the site"}  # fmt: skip
PAGE_WORD = {"home": "Home page", "archive": "Archive", "tag": "Tag page", "notfound": "Page not found"}  # fmt: skip


def _whole(x: float) -> int:
    """Halves up, as the page shows a share."""
    return math.floor(x + 0.5)


def duration(ms: int) -> str:
    """1m 05s, 2h 03m."""
    s = (ms + 500) // 1000
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60:02d}s"
    return f"{s // 3600}h {(s % 3600) // 60:02d}m"


STATS_CSS = """.ranges{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 6px}.range{padding:8px 12px;border:1px solid var(--rule);border-radius:999px;text-decoration:none;font-size:15px;color:var(--accent)}
.range.on{background:var(--accent);color:#fff;border-color:var(--accent)}h2.sub{margin:32px 0 0}.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0}
@media(min-width:560px){.stats{grid-template-columns:repeat(4,minmax(0,1fr))}}.stat{background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:2px}
.stat b{font:500 24px/1.2 ui-monospace,Menlo,monospace}.stat span{font-size:13px;color:var(--muted)}.kv{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px;color:var(--muted);margin:8px 0 12px}
.bar-row{display:grid;grid-template-columns:48px 1fr 36px;gap:8px;align-items:center;font:13px ui-monospace,Menlo,monospace;margin:4px 0}.bar{background:var(--bg);border-radius:3px;height:12px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--accent)}.bar-num{text-align:right}.drop{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.drop-step{display:flex;flex-direction:column;align-items:center;gap:4px;font:12px ui-monospace,Menlo,monospace;color:var(--muted)}.drop-bar{width:100%;height:56px;background:var(--bg);border-radius:4px;display:flex;align-items:flex-end;overflow:hidden}
.drop-bar span{display:block;width:100%;background:var(--accent)}.drop-num{color:var(--ink)}.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--rule);overflow-wrap:anywhere}
.row:last-child{border-bottom:0}.sub-row{font-size:14px;color:var(--muted);padding-left:12px}"""


async def stats_page(req: Request, cx: Context) -> Response:
    asked = req.query_params.get("days") or "7"
    days = asked if any(k == asked for k, _ in RANGES) else "7"
    s = await analytics.stats(cx.db, days=int(days))
    t = s["totals"]
    peak = max([0, *(d["visits"] for d in s["daily"])])

    def tile(value: str, label: str) -> str:
        return f'<div class="stat"><b>{esc(value)}</b><span>{esc(label)}</span></div>'

    ranges = "".join(
        f'<a class="range{" on" if k == days else ""}" href="/review/stats?days={esc(k)}">{esc(label)}</a>'
        for k, label in RANGES
    )
    tiles = (
        tile(str(t["visits"]), "visitors")
        + tile(str(t["views"]), "pages read")
        + tile(duration(t["median_visit_engaged_ms"]), "typical stay")
        + tile(f"{_whole(t['bounce_rate'])}%", "left right away")
    )
    multi = (
        f'<p class="meta">{_whole(t["multi_page_rate"])}% read more than one page. A visitor is one person on one day.</p>'
        if t["visits"]
        else ""
    )
    by_day = ""
    if len(s["daily"]) > 1:
        bars = "".join(
            f'<div class="bar-row"><span class="bar-label">{esc(d["day"][5:])}</span><span class="bar"><span style="width:{_whole(100 * d["visits"] / peak) if peak else 0}%"></span></span><span class="bar-num">{d["visits"]}</span></div>'
            for d in s["daily"]
        )
        by_day = f'<h2 class="sub">By day</h2><div class="card">{bars}</div>'
    if s["pages"]:
        cards = []
        for p in s["pages"]:
            bounce = (
                ""
                if p["bounce_rate"] is None
                else f"<span>{_whole(p['bounce_rate'])}% left right away</span>"
            )
            steps = "".join(
                f'<div class="drop-step"><span class="drop-bar"><span style="height:{_whole(p["reached"][k])}%"></span></span><span class="drop-label">{k}%</span><span class="drop-num">{_whole(p["reached"][k])}%</span></div>'
                for k in ("25", "50", "75", "100")
            )
            title = p["title"] or PAGE_WORD.get(p["kind"]) or p["path"]
            cards.append(
                f'<div class="card"><div class="meta">{esc(p["kind"])} · {esc(p["path"])}</div><h2>{esc(title)}</h2>\n'
                f'<div class="kv"><span>{p["readers"]} reader{"" if p["readers"] == 1 else "s"}</span><span>typical {duration(p["median_engaged_ms"])}</span><span>avg {duration(p["mean_engaged_ms"])}</span>{bounce}</div>\n'
                f'<div class="drop">{steps}</div>\n'
                f'<p class="meta">Share of readers who got that far down the page. {p["exits"]} left the site from here.</p></div>'
            )
        pages = "".join(cards)
    else:
        pages = '<p class="meta">No visitors yet in this range.</p>'
    sources = ""
    if s["sources"]:
        rows = "".join(
            f'<div class="row"><span>{esc(SOURCE_WORD.get(r["source"], r["source"]))}</span><span>{r["visits"]} · {duration(r["engaged_ms"])}</span></div>'
            for r in s["sources"]
        ) + "".join(
            f'<div class="row sub-row"><span>{esc(d["domain"])}</span><span>{d["visits"]}</span></div>'
            for d in s["referring_domains"]
        )
        sources = f'<h2 class="sub">Where they came from</h2><div class="card">{rows}</div>'
    tagged = ""
    if s["tagged"]:
        rows = "".join(
            f'<div class="row"><span>{esc(r["src"])}{esc(" · " + r["post"]) if r["post"] else ""}</span><span>{r["visits"]} · {duration(r["visit_engaged_ms"])}</span></div>'
            for r in s["tagged"]
        )
        tagged = f'<h2 class="sub">Tagged links</h2><div class="card">{rows}</div>'
    earlier = ""
    if s["earlier"]:
        rows = "".join(
            f'<div class="row"><span>{esc(r["month"])}</span><span>{r["visits"]} visits · {r["views"]} views</span></div>'
            for r in s["earlier"]
        )
        earlier = f'<h2 class="sub">Earlier, counts only</h2><div class="card">{rows}</div><p class="meta">Past 90 days only the totals are kept.</p>'
    return owner_page(
        "Stats",
        f"""<h1>Who's reading</h1>
<div class="ranges">{ranges}</div>
<p class="meta">{esc(s["range"]["start"])} to {esc(s["range"]["end"])} · you, bots and test runs aren't counted</p>
<p class="meta">Time on page and scroll can lag up to a minute while someone is still reading. Browser or connection delays can make that longer. If the final message is lost, recorded time and scroll can be lower.</p>
<div class="stats">{tiles}</div>
{multi}
{by_day}
<h2 class="sub">What they read</h2>
{pages}
{sources}
{tagged}
{earlier}
<p class="meta" style="margin-top:32px">This browser isn't counted because you're signed in. To leave another device out without signing in, open any page of the site with <code>?sk_notrack=1</code> on the end.</p>
<style>{STATS_CSS}</style>""",
        signed_in=True,
    )


# --- owner: the writing desk -------------------------------------------------------------------


def _values_of(item: dict[str, Any]) -> dict[str, str]:
    d = item["data"]
    return {
        "stream": string(d.get("stream")),
        "title": string(d.get("title")),
        "summary": string(d.get("summary")),
        "date": string(d.get("date")),
        "tags": " ".join(d.get("tags") or []),
        "cover": string(d.get("cover")),
        "cover_alt": string(d.get("cover_alt")),
        "body": string(d.get("body")),
    }


def _desk_error(e: ApiError) -> str:
    if e.code in ("version_conflict", "item_changed"):
        return "This entry changed since you opened it (your assistant may have edited it). Copy your text, reload, and redo the change."
    problems = e.extra.get("problems") or []
    detail = "; ".join(f"{p['field'] or 'entry'}: {p['problem']}" for p in problems)
    return f"{e.message} {detail}".strip()


async def write_index(req: Request, cx: Context) -> Response:
    published = req.query_params.get("published") or ""
    entries = await desk.entries(cx.db)
    streams = (await content.site_data(cx.db, False))["streams"]

    def stream_title(id: str) -> str:
        found = next((x for x in streams if x["id"] == id), streams[0] if streams else None)
        return found["title"] if found else ""

    if entries:
        rows = "".join(
            f'<a class="card" href="/review/write/{esc(e["id"])}"><span class="tag">{esc(e["state"])}</span><h2 style="margin-top:8px">{esc(e["data"]["title"])}</h2><div class="meta">{esc(e["data"]["date"])} · {esc(stream_title(string(e["data"].get("stream"))))}{esc("".join(f" #{t}" for t in e["data"].get("tags") or []))}</div></a>'
            for e in entries
        )
    else:
        rows = '<p class="meta">Nothing yet.</p>'
    ok = '<p class="ok">Published. It\'s live on the site.</p>' if published else ""
    return owner_page(
        "Writing",
        f"""<h1>Writing</h1><p class="meta">Every entry on your site, newest first. Your assistant's drafts show up here too: finish one and publish it yourself.</p>
{ok}
<p><a class="button" href="/review/write/new">Write something new</a></p>
{rows}""",
        signed_in=True,
    )


async def write_form(
    req: Request,
    cx: Context,
    item: dict[str, Any] | None,
    v: dict[str, str],
    error: str = "",
    saved: bool = False,
    status: int = 200,
) -> Response:
    streams = (await content.site_data(cx.db, False))["streams"]
    chosen = v["stream"] or streams[0]["id"]
    is_live = bool(item) and item["state"] in ("live", "live, edited since")
    page = None
    if is_live:
        page = next(
            (x["url"] for x in (await content_view(req,cx)).entries if x["id"] == item["id"]), None
        )
    state = ""
    if item:
        see = f' <a href="{esc(page)}">See it on the site</a>' if page else ""
        state = f'<p><span class="tag">{esc(item["state"])}</span>{see}</p>'
    err = f'<p class="error">{esc(error)}</p>' if error else ""
    ok = ""
    if saved:
        more = (
            " Not live until you publish."
            if item and item["state"] not in ("draft", "live")
            else ""
        )
        ok = f'<p class="ok">Saved.{more}</p>'
    options = "".join(
        f'<option value="{esc(x["id"])}"{" selected" if x["id"] == chosen else ""}>{esc(x["title"])}</option>'
        for x in streams
    )
    draft = " as a draft" if not item or item["state"] == "draft" else ""
    return owner_page(
        "Edit" if item else "Write",
        f"""<h1>{"Edit" if item else "Write something new"}</h1>
{state}
{err}{ok}
<form method="post" action="/review/write/{esc(item["id"]) if item else "new"}"><input type="hidden" name="csrf" value="{esc(owner.csrf(req))}"><input type="hidden" name="version" value="{esc(str(item["version"])) if item else ""}">
<label for="stream">Where it goes</label><select id="stream" name="stream">{options}</select>
<label for="title">Title</label><input type="text" id="title" name="title" value="{esc(v["title"])}" maxlength="160" required>
<label for="summary">One or two sentences, shown in lists</label><input type="text" id="summary" name="summary" value="{esc(v["summary"])}" maxlength="600">
<label for="date">Date</label><input type="date" id="date" name="date" value="{esc(v["date"])}" required>
<label for="tags">Tags (separate with spaces or commas)</label><input type="text" id="tags" name="tags" value="{esc(v["tags"])}">
<label for="cover">Picture: a full https:// link, or a /media/... path (optional)</label><input type="text" id="cover" name="cover" value="{esc(v["cover"])}">
<label for="cover_alt">What the picture shows, for people who can't see it</label><input type="text" id="cover_alt" name="cover_alt" value="{esc(v["cover_alt"])}" maxlength="200">
<label for="body">Text</label><textarea class="body" id="body" name="body" maxlength="60000">{esc(v["body"])}</textarea>
<p class="meta">Markdown: a blank line between paragraphs, **bold**, *italic*, [a link](https://example.com), ## a heading.</p>
<button name="action" value="publish">{"Publish the changes" if is_live else "Publish"}</button>
<button class="second" name="action" value="preview">Save and preview</button>
<button class="second" name="action" value="save">Save{draft}</button>
<p class="meta">Publishing makes this entry live at once. Nothing else that's waiting goes with it.</p></form>""",
        signed_in=True,
        status=status,
    )


async def write_new(req: Request, cx: Context) -> Response:
    tz = str((await content.site_data(cx.db, True)).get("timezone") or "UTC")
    blank = {k: "" for k in desk.FIELDS} | {"date": analytics.local_day(datetime.now(UTC), tz)}
    return await write_form(req, cx, None, blank)


async def write_edit(req: Request, cx: Context, id: str) -> Response:
    item = await desk.get(cx.db, id)
    return await write_form(req, cx, item, _values_of(item), saved="saved" in req.query_params)


async def write_save(req: Request, cx: Context, id: str) -> Response:
    form = await _form(req)
    values = {k: _field(form, k) for k in desk.FIELDS}
    current = None if id == "new" else await desk.get(cx.db, id)
    if _field(form, "csrf") != owner.csrf(req):
        return await write_form(req, cx, current, values, error="This form expired. Try again.", status=403)  # fmt: skip
    action = _field(form, "action") or "save"
    raw_version = _field(form, "version").strip()
    version = int(raw_version) if re.fullmatch(r"[+-]?\d+", raw_version) else None
    try:
        saved = await desk.save(cx.db, current["id"] if current else None, version, values)
        current = await desk.get(cx.db, saved["id"])
        if action == "publish":
            await desk.publish(cx.db, saved["id"], saved["version"])
            return redirect(f"{origin_of(req)}/review/write?published={saved['id']}", 303)
    except ApiError as e:
        return await write_form(req, cx, current, values, error=_desk_error(e), status=e.status)
    if action == "preview":
        return redirect(f"{origin_of(req)}/review/write/{saved['id']}/preview", 303)
    return redirect(f"{origin_of(req)}/review/write/{saved['id']}?saved=1", 303)


async def write_preview(req: Request, cx: Context, id: str) -> Response:
    """The entry's page as publishing it now would make it, a draft included."""
    item = await desk.get(cx.db, id)
    v = await site.proposed_view(cx.db, [{"id": id, "version": item["version"]}], id)
    t = await themes.load(cx.db, str(v.site["theme"]))
    origin = origin_of(req)
    e = next((x for x in v.entries if x["id"] == id and not x.get("external_url")), None)
    if t:
        body = (
            render(t, "entry", views.entry_view(v, e, "preview", origin))
            if e
            else render(t, "home", views.home_view(v, "preview", origin))
        )
    else:
        body = (builtin.entry_page(v, e["page"]) if e else builtin.home(v)).body.decode("utf-8")
    body = site.inline_css(t, v, body)
    btn = "font:600 15px/1 -apple-system,sans-serif;border-radius:6px;padding:12px 16px;border:0;cursor:pointer"
    bar = f"""<div style="position:sticky;top:0;z-index:99;background:#1c1f1d;color:#fff;font:15px/1.4 -apple-system,sans-serif;padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
<span>Preview: not live until you publish.</span><a style="{btn};background:#fff;color:#1c1f1d;text-decoration:none" href="/review/write/{esc(id)}">Back to writing</a></div>"""
    page = re.sub(r"<body([^>]*)>", lambda m: f"<body{m.group(1)}>{bar}", body, count=1)
    return respond(
        page, headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"}, csp=THEME_CSP
    )


# --- owner: the site's history, and putting it back --------------------------------------------


def _when(iso: str) -> str:
    return f"{iso[:16].replace('T', ' ', 1)} UTC"


KIND_NAME = {"site": "site", "entry": "entry", "card": "card", "note": "note"}


def _by_whom(p: dict[str, Any]) -> str:
    if not p["approval_id"]:
        return "you"
    who = re.sub(r"^assistant:", "", p["requested_by"]) or "your assistant"
    return f"you approved {who}'s request"


async def history_page(req: Request, cx: Context) -> Response:
    items = await history.publishes(cx.db)
    if items:
        cards = []
        for i, p in enumerate(items):
            note = f"<p>{esc(p['note'])}</p>" if p["note"] else ""
            what = "".join(
                f'<h2 style="margin-top:8px">{esc(it["label"])}</h2><div class="meta">{esc(KIND_NAME.get(it["kind"], it["kind"]))} · {"taken off" if it["removed"] else "published"}</div>'
                for it in p["items"]
            )
            back = (
                '<p class="meta">This is the site now.</p>'
                if i == 0
                else f'<a class="go" href="/review/history/{p["id"]}">Put the site back to this →</a>'
            )
            cards.append(
                f'<div class="card"><div class="meta">{esc(_when(p["created_at"]))} · {esc(_by_whom(p))}</div>{note}{what}{back}</div>'
            )
        body = "".join(cards)
    else:
        body = '<p class="meta">Nothing has been published yet.</p>'
    return owner_page(
        "History",
        f"""<h1>History</h1><p class="meta">Every time the site changed, newest first. You can put the site back to how it was after any of them; that is a new change, and it can be undone the same way.</p>
{body}""",
        signed_in=True,
    )


async def revert_page(req: Request, cx: Context, id: int, error: str = "") -> Response:
    p = await history.plan(cx.db, id)
    plan = p["changes"]
    embed_warn = await _embed_review_for(cx.db, plan, origin_of(req))
    embed_warn += await _private_review_warning(cx.db, plan)
    err = f'<p class="error">{esc(error)}</p>' if error else ""
    if plan:
        listed = "".join(
            f'<h2 style="margin-top:8px">{esc(c["label"])}</h2><div class="meta">{esc(KIND_NAME.get(c["kind"], c["kind"]))} · {"taken off" if c["action"] == "take off" else "put back"}</div>'
            + (
                changes.taken_off(c["label"])
                if c["deleted"]
                else changes.what_changed(c["kind"], c["data"], c["live"])
                if c["live"] is not None
                else changes.what_it_says(c["kind"], c["data"], True)
            )
            for c in plan
        )
        what = f"""<div class="card">{listed}</div>
<form method="post"><input type="hidden" name="csrf" value="{esc(owner.csrf(req))}"><label>Why (kept with the history; optional)</label><textarea name="note" rows="2"></textarea><button data-busy="{esc(_busy_word(len(plan), "Putting back"))}">Put the site back to this</button></form>
<p class="meta">This goes live at once. Anything your assistant was drafting on these items is set aside; it stays in each item's history.</p>"""
    else:
        what = "<p>The site already matches this.</p>"
    return owner_page(
        "Put the site back",
        f"""<h1>Put the site back?</h1><p>Back to how it was after the change on {esc(_when(p["publish"]["created_at"]))}.</p>{err}
{embed_warn}{what}
<p><a href="/review/history">Back to the history</a></p>""",
        signed_in=True,
        script=BUSY_JS,
    )


async def revert_do(req: Request, cx: Context, id: int) -> Response:
    form = await _form(req)
    if _field(form, "csrf") != owner.csrf(req):
        return await revert_page(req, cx, id, "This form expired. Try again.")
    try:
        await history.revert(cx.db, id, _field(form, "note"), origin_of(req))
    except ApiError as e:
        return await revert_page(req, cx, id, e.message)
    return owner_page(
        "Put back",
        """<h1>Your site is back</h1><p>It's live now as it was then.</p><p><a class="button" href="/">See your site</a></p><p><a href="/review/history">Back to the history</a></p>""",
        signed_in=True,
    )


# --- visitors: the beacon's endpoint ------------------------------------------------------------


def client_ip(req: Request) -> str:
    """The visitor's address. The web server in front appends the real peer to
    X-Forwarded-For, so the LAST entry is the one a client can't forge."""
    forwarded = [p.strip() for p in (req.headers.get("x-forwarded-for") or "").split(",") if p.strip()]  # fmt: skip
    if forwarded:
        return forwarded[-1]
    return req.client.host if req.client else ""


async def collect_beacon(req: Request, cx: Context) -> Response:
    """Always 204: the page has no use for an answer."""
    try:
        raw = await req.body()
    except Exception:
        raw = b""
    await analytics.collect(
        cx.db,
        raw,
        ip=client_ip(req),
        ua=u16slice(req.headers.get("user-agent") or "", 0, 400),
        notrack=bool(owner.cookie(req, analytics.NOTRACK_COOKIE)),
        host=req.url.hostname or "",
    )
    return Response(None, status_code=204, headers={"Cache-Control": "no-store"})


BEACON_HEADERS = {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
}


# --- the router ------------------------------------------------------------------------------

_PROOF = re.compile(r"^/\.well-known/sitekeeper-proof/([A-Za-z0-9_-]{20,64})\Z")
_ENTRY = re.compile(r"^/[a-z][a-z0-9-]{0,29}/[a-z0-9-]{1,80}/\Z")
_IMG = re.compile(r"^/media/([0-9a-f]{32}\.(?:jpg|png|webp))\Z")
_UPLOAD = re.compile(r"^/upload/([A-Za-z0-9_-]{32})\Z")
_ADD = re.compile(r"^/passkey/([A-Za-z0-9_-]{32})(/options|/verify)?\Z")
_PREVIEW = re.compile(r"^/review/([A-Za-z0-9_-]{8,40})/preview(/.*)?\Z")
_REVIEW = re.compile(r"^/review/([A-Za-z0-9_-]{8,40})\Z")
_BACK = re.compile(r"^/review/history/(\d{1,12})\Z")
_WRITE_PREVIEW = re.compile(r"^/review/write/([a-z]{2,8}_[0-9a-f]{4,40})/preview\Z")
_WRITE = re.compile(r"^/review/write/(new|[a-z]{2,8}_[0-9a-f]{4,40})\Z")


async def _json_body(req: Request) -> Any:
    try:
        return await req.json()
    except Exception:
        return {}


async def handle(req: Request, cx: Context) -> Response:
    is_private,gated,response = await privacy.access(cx.db,req)
    get = Request({**req.scope,"method":"GET"},req.receive) if req.method == "HEAD" else req
    if response is None:
        response = await _route(get,cx)
    if is_private and gated:
        response = privacy.no_store(response)
    if re.match(r"/(?:recover|invite)(?:/|$)",req.url.path):
        response.headers["Referrer-Policy"]="no-referrer"
        if not is_private or not gated:
            response.headers["Cache-Control"]="no-store"
    if req.method == "HEAD":
        response.body = b""
    return response


async def _route(req: Request, cx: Context) -> Response:
    path = _path(req)
    m = req.method
    try:
        if path == "/.well-known/porchsite-release" and m == "GET":
            response = json_response({"release":cx.release,"private_floor":await privacy.private_floor(cx.db,cx.release)})
            response.headers["Cache-Control"]="private, no-store"
            return response
        if path == "/recover" and m == "GET":
            return await recovery_page(req,cx)
        if path == "/recover/options" and m == "POST":
            body = await _json_body(req)
            options,cookie = await owner.recover_options(cx.db,req,str(body.get("code") or ""))
            return json_response({"options":options},headers=[("Set-Cookie",cookie),("Referrer-Policy","no-referrer")])
        if path == "/recover/verify" and m == "POST":
            return signed_in_json(await owner.recover_verify(cx.db,req,await _json_body(req)))
        invite = re.fullmatch(r"/invite/([A-Za-z0-9_-]{32})(/options|/verify)?",path)
        if invite and not invite.group(2) and m == "GET":
            return owner_page("Reader invitation",'<h1>Read this site</h1><p>Create your own passkey to read published pages. This does not give you owner access.</p><form><p class="error" hidden></p><button>Create reader passkey</button></form>',headers=[("Referrer-Policy","no-referrer")],script='history.replaceState(null,"","/login");\n'+passkey_js("invite","/",f"invite/{invite.group(1)}"))
        if invite and invite.group(2) == "/options" and m == "POST":
            options,cookie = await owner.invite_options(cx.db,req,invite.group(1))
            return json_response({"options":options},headers=[("Set-Cookie",cookie),("Referrer-Policy","no-referrer")])
        if invite and invite.group(2) == "/verify" and m == "POST":
            return signed_in_json(await owner.invite_verify(cx.db,req,await _json_body(req)))
        # The kit's beacon, whatever the site's look.
        if path == "/static/a.js" and m == "GET":
            return Response(BEACON_JS.encode("utf-8"), headers=BEACON_HEADERS)
        if path == "/collect" and m == "POST":
            return await collect_beacon(req, cx)
        # A theme, when the site text names one; otherwise the built-in look.
        if m == "GET":
            themed = await themed_page(req, cx, path)
            if themed:
                return themed
        if path == "/sitemap.xml" and m == "GET":
            v = await content_view(req,cx,discovery=True)
            return Response(
                sitemap(v, origin_of(req), (themes.is_built_in(str(v.site["theme"])) or bool(await themes.load(cx.db, str(v.site["theme"]))))),
                headers=SITEMAP_HEADERS,
            )
        if path == "/" and m == "GET":
            return builtin.home(await content_view(req,cx), origin_of(req))
        # Open to every crawler and agent. Pages that mustn't be indexed (the
        # owner's) say so themselves with noindex, which a crawler can only see
        # if it may fetch them.
        proof = _PROOF.search(path)
        if proof and m == "GET":
            yes = await requests.answer_proof(cx.db, proof.group(1))
            return Response(
                "ok" if yes else "no",
                status_code=200 if yes else 404,
                headers={"Content-Type": "text/plain", "Cache-Control": "no-store"},
            )
        if path == "/robots.txt" and m == "GET":
            return Response(
                robots(origin_of(req)),
                headers={
                    "Content-Type": "text/plain; charset=utf-8",
                    "Cache-Control": "public, max-age=3600",
                },
            )
        if _ENTRY.search(path) and m == "GET":
            page = builtin.entry_page(await content_view(req,cx), path, origin_of(req))
            if page:
                return page

        img = _IMG.search(path)
        if img and m == "GET":
            # Nothing is public before the owner's yes, images included; the owner
            # sees unpublished ones on the review page.
            is_public = await media.published(cx.db, img.group(1))
            shown = (
                await media.serve(cx.db, img.group(1), is_public)
                if is_public or await owner.signed_in(cx.db, req)
                else None
            )
            return _file(shown) or builtin.not_found(await content_view(req,cx), origin_of(req))

        up = _UPLOAD.search(path)
        if up and m in ("GET", "POST"):
            return await upload_page(req, cx, up.group(1))

        if path == "/setup" and m == "GET":
            return await setup_page(req, cx)
        if path == "/setup/options" and m == "POST":
            body = await _json_body(req)
            body = body if isinstance(body, dict) else {}
            options, cookie = await owner.setup_options(
                cx.db,
                req,
                cx.setup_code,
                string(body.get("code") or ""),
                u16slice(string(body.get("name") or ""), 0, 80),
            )
            return json_response({"options": options}, headers=[("Set-Cookie", cookie)])
        if path == "/setup/verify" and m == "POST":
            cookie = await owner.setup_verify(cx.db, req, cx.setup_code, await _json_body(req))
            return signed_in_json(cookie)
        add = _ADD.search(path)
        if add and not add.group(2) and m == "GET":
            return await add_passkey_page(cx, add.group(1))
        if add and add.group(2) == "/options" and m == "POST":
            options, cookie = await owner.add_options(cx.db, req, add.group(1))
            return json_response({"options": options}, headers=[("Set-Cookie", cookie)])
        if add and add.group(2) == "/verify" and m == "POST":
            cookie = await owner.add_verify(cx.db, req, await _json_body(req))
            return signed_in_json(cookie)
        if path == "/login" and m == "GET":
            return await login_page(req, cx)
        if path == "/login/options" and m == "POST":
            options, cookie = await owner.login_options(cx.db, req)
            return json_response({"options": options}, headers=[("Set-Cookie", cookie)])
        if path == "/login/verify" and m == "POST":
            cookie = await owner.login_verify(cx.db, req, await _json_body(req))
            return signed_in_json(cookie)
        if path == "/logout" and m == "POST":
            form = await _form(req)
            if _field(form, "csrf") == owner.csrf(req):
                cookie = await owner.sign_out(cx.db, req)
                return _with_raw(redirect("/", 303), [("Set-Cookie", cookie)])
            return redirect(f"{origin_of(req)}/review", 303)

        if path == "/authorize":
            return await (authorize_post(req, cx) if m == "POST" else authorize_get(req, cx))

        if path == "/review" or path.startswith("/review/"):
            gate = await require_owner(req, cx)
            if gate:
                return gate
            if path == "/review/readers":
                return await readers_page(req,cx)
            if path == "/review" and m == "GET":
                return await review_index(req, cx)
            # Share cards: the owner's browser draws them (sharecards.py).
            if path == "/review/import":
                if m == "POST":
                    form = await req.form(max_part_size=importer.MAX_FILE + 1024)
                    if form.get("csrf") != owner.csrf(req):
                        return await import_page(req, "This form expired. Try again.")
                    f = form.get("file")
                    if not isinstance(f, UploadFile) or not f.size:
                        return await import_page(req, "Choose the file your assistant gave you.")
                    if f.size > importer.MAX_FILE:
                        return await import_page(req, "That file is over 25 MB.")
                    try:
                        done = await importer.import_file(
                            cx.db, (await f.read()).decode("utf-8", errors="replace")
                        )
                    except ApiError as e:
                        problems = [
                            f"Item {p['item']}: {p['message']}" for p in e.extra.get("problems", [])
                        ]
                        return await import_page(req, e.message, problems)
                    return redirect(f"{origin_of(req)}/review/{done['approval']}", 303)
                return await import_page(req)
            if path == "/review/cards.json" and m == "GET":
                host = urlsplit(origin_of(req)).hostname or ""
                return json_response({"cards": await sharecards.missing(cx.db, host)})
            card = _CARD.search(path)
            if card and m == "POST":
                if req.headers.get("x-csrf") != owner.csrf(req):
                    return json_response(
                        {"error": "csrf", "message": "This page expired. Reload it."}, 403
                    )
                try:
                    version = int(req.query_params.get("version") or "0")
                except ValueError:
                    version = 0
                await sharecards.save(cx.db, card.group(1), version, await req.body())
                return Response(status_code=204)
            if path == "/review/passkeys":
                if m == "POST":
                    form = await _form(req)
                    if _field(form, "csrf") == owner.csrf(req):
                        return await passkeys_page(req, cx, await owner.create_passkey_link(cx.db,req))
                return await passkeys_page(req, cx)
            if path == "/review/assistants":
                if m == "POST":
                    form = await _form(req)
                    if _field(form, "csrf") != owner.csrf(req):
                        return await assistants_page(req, cx)
                    if _field(form, "make_key"):
                        name = _field(form, "key_name").strip()[:40] or "Assistant"
                        made = {"name": name, **(await keys.create(cx.db, name))}
                        return await assistants_page(req, cx, None, made)
                    if _field(form, "revoke_key"):
                        await keys.revoke(cx.db, _field(form, "revoke_key"))
                        return await assistants_page(req, cx)
                    return await assistants_page(req, cx, _field(form, "revoke"))
                return await assistants_page(req, cx)
            if path == "/review/stats" and m == "GET":
                return await stats_page(req, cx)
            if path == "/review/history" and m == "GET":
                return await history_page(req, cx)
            back = _BACK.search(path)
            if back:
                n = int(back.group(1))
                return await (revert_do(req, cx, n) if m == "POST" else revert_page(req, cx, n))
            if path == "/review/write" and m == "GET":
                return await write_index(req, cx)
            if path == "/review/write/new" and m == "GET":
                return await write_new(req, cx)
            wp = _WRITE_PREVIEW.search(path)
            if wp and m == "GET":
                return await write_preview(req, cx, wp.group(1))
            w = _WRITE.search(path)
            if w:
                return await (
                    write_save(req, cx, w.group(1))
                    if m == "POST"
                    else write_edit(req, cx, w.group(1))
                )
            pv = _PREVIEW.search(path)
            if pv and m == "GET":
                return await review_preview(req, cx, pv.group(1), pv.group(2) or "/")
            rid = _REVIEW.search(path)
            if rid:
                return await (
                    review_decide(req, cx, rid.group(1))
                    if m == "POST"
                    else review_show(req, cx, rid.group(1))
                )

        return await not_found_page(req, cx)
    except privacy.PrivateContentDenied:
        return privacy.blank_response()
    except ApiError as e:
        if "json" in (req.headers.get("content-type") or "") or path.endswith(
            ("/options", "/verify")
        ):
            return json_response(e.to_json(), e.status)
        return owner_page(
            "Problem", f"<h1>Something's wrong</h1><p>{esc(e.message)}</p>", status=e.status
        )


async def _embed_review_for(db, changes, origin):
    if not any(c["kind"] == "site" or (c["kind"] == "entry" and "!embed[" in c["data"].get("body", "")) for c in changes):
        return ""
    live = await approvals.live_rows(db)
    proposed = {r["id"]:r for r in live}
    for c in changes:
        if c.get("deleted"):
            proposed.pop(c["id"], None)
        else:
            proposed[c["id"]] = c
    return embed_review(live, list(proposed.values()), changes, origin)


async def recovery_page(req,cx):
    headers = [("Referrer-Policy","no-referrer")]
    if not await owner.has_owner(cx.db):
        return owner_page("Recovery","<h1>This site has no owner yet.</h1>",status=409,headers=headers)
    code = req.query_params.get("code","")[:200]
    body = '<h1>Recover owner access</h1><p>Use this if you can&#39;t sign in on any device. Your recovery code replaces all your old passkeys, so a lost or stolen device can&#39;t get back in. Everyone is signed out; unused reader invitations are cancelled. Readers keep their passkeys and just sign in again.</p><form><label>Recovery code</label><input type="password" name="code" autocomplete="off" value="'+esc(code)+'" required><p class="error" hidden></p><button>Recover my site</button></form>'
    return owner_page("Recover owner access",body,headers=headers,script=SETUP_JS+passkey_js("recover","/review"))


async def readers_page(req,cx):
    csrf = owner.csrf(req)
    link = ""
    if req.method == "POST":
        form = await _form(req)
        if _field(form,"csrf") != csrf:
            raise ApiError(403,"csrf","This form expired. Try again.")
        id = _field(form,"id")
        if _field(form,"action") == "revoke":
            await owner.revoke_reader(cx.db,id)
        elif _field(form,"action") == "revoke-invite":
            await owner.revoke_invite(cx.db,id)
        else:
            invite = await owner.create_reader_invite(cx.db,_field(form,"name") or "Reader",req)
            link = origin_of(req)+"/invite/"+invite["token"]
    body = '<h1>Readers</h1><p>Invite someone to read this site with their own passkey. An invitation link works once and lasts seven days. Revoking someone stops their access right away; pages they already opened stay on their device.</p>'
    if link:
        body += f'<p class="ok">Give this one-time link privately: <a href="{esc(link)}">{esc(link)}</a></p>'
    body += f'<form method="post"><input type="hidden" name="csrf" value="{esc(csrf)}"><label>Reader name</label><input type="text" name="name" maxlength="80" required><button>Create invitation</button></form>'
    readers = await owner.list_readers(cx.db)
    zone = ZoneInfo((await content_view(req,cx,discovery=True)).site.get("timezone") or "UTC")
    def date(value):
        return long_date(datetime.fromisoformat(value.replace("Z","+00:00")).astimezone(zone).date().isoformat())
    def form(r,invite):
        button = '<button class="second" name="action" value="revoke-invite">Cancel invitation</button>' if invite else f'<button class="warn" name="action" value="revoke">Remove {esc(r["name"])}</button>'
        return f'<form method="post"><input type="hidden" name="csrf" value="{esc(csrf)}"><input type="hidden" name="id" value="{esc(r["id"])}">{button}</form>'
    body += '<h2>Readers</h2>'
    for r in readers:
        if not r["used_at"]:
            continue
        signed_in = "Last signed in " + date(r["last_signed_in"]) if r["last_signed_in"] else "Not signed in yet"
        action = '<p>Removed</p>' if r["revoked"] else form(r,False)
        body += f'<section class="card"><h3>{esc(r["name"])}</h3><p>Added {esc(date(r["created_at"]))}</p><p>{esc(signed_in)}</p>{action}</section>'
    body += '<h2>Unused invitations</h2>'
    for r in readers:
        if r["used_at"] or not r["expires_at"] or r["revoked"]:
            continue
        expired = '<p>Expired</p>' if r["expires_at"] <= owner.now() else ""
        body += f'<section class="card"><h3>{esc(r["name"])}</h3><p>Expires {esc(date(r["expires_at"]))}</p>{expired}{form(r,True)}</section>'

    return owner_page("Readers",body,signed_in=True,headers=[("Referrer-Policy","no-referrer")])


async def _private_review_warning(db, proposed):
    live = await privacy.live_private(db)
    out = ""
    for item in proposed:
        if item["kind"] != "site":
            continue
        mode = bool(item.get("data",{}).get("private")) and not item.get("deleted")
        if live and not mode:
            out += '<h2 class="warn">This makes the site public.</h2>'
        elif mode and not live:
            out += '<h2 class="warn">Passkeys will be required to read this site.</h2><p class="warn">Pictures and pages people already saved, and search-engine copies, stay available. Pages already loading may finish opening.</p>'
    return out
