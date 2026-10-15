"""The built-in look: the public site when the site item names no installed
theme (its default, "built-in"). Every word on it comes from content (SPEC
§6). Port of the page half of cloudflare/src/site.ts (home, entryPage,
redirectFor, notFound); the view itself is server/spec/site.py and
server/app/site.py.
"""

import re
from typing import Any

from starlette.responses import Response

from server.spec.embeds import PERMISSIONS, body_markdown, finish_embeds, frame_csp
from server.spec.jsutil import DOT, long_date, short_date, u16slice
from server.spec.site import SiteView
from server.spec.strings import strings_of

from .html import esc, markdown, redirect, respond

Data = dict[str, Any]

CSS = """
:root{--bg:#f6f4ef;--card:#fffdf8;--ink:#1d1f1c;--body:#363a34;--muted:#5b6159;--rule:#ddd8cc;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root{--bg:#161816;--card:#1e211e;--ink:#eceae4;--body:#d3d1ca;--muted:#a3a79f;--rule:#343833;--accent:#8cc4b2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--body);font:17px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:0 18px 64px}header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:18px 0;border-bottom:1px solid var(--rule)}
.logo{font-weight:700;color:var(--ink);text-decoration:none}nav a{color:var(--muted);margin-left:14px;text-decoration:none;font-size:15px}
h1,h2,h3{color:var(--ink);line-height:1.25;font-family:Georgia,"Times New Roman",serif}h1{font-size:34px;margin:36px 0 10px}h2{font-size:24px;margin:44px 0 14px}
a{color:var(--accent)}.lede{font-size:19px}.meta{color:var(--muted);font-size:14px}
.entry,.card{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:18px;margin:14px 0}
.entry h3{margin:4px 0 6px;font-size:21px}.entry h3 a{color:var(--ink);text-decoration:none}
.cards{display:grid;gap:14px}@media(min-width:620px){.cards{grid-template-columns:1fr 1fr}}.card{margin:0}
.card h3{margin:0 0 6px;font-size:18px}.badge{font-size:12px;border:1px solid var(--rule);border-radius:99px;padding:2px 8px;color:var(--muted)}
.notes{list-style:none;padding:0}.notes li{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--rule)}.notes .meta{min-width:56px}
article img,.hero,.cover{max-width:100%;height:auto;border-radius:8px;display:block}.hero{margin:24px 0 0;width:100%}
.entry .cover{margin:-18px -18px 14px;max-width:calc(100% + 36px);width:calc(100% + 36px);border-radius:10px 10px 0 0;aspect-ratio:16/9;object-fit:cover}
.card .cover{margin-bottom:12px;width:100%;aspect-ratio:16/9;object-fit:cover}article .cover{margin:18px 0}footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);color:var(--muted);font-size:14px}
.tags a{margin-right:8px;font-size:14px}.byline{color:var(--muted);margin:-8px 0 14px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.stat{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:10px 14px;min-width:96px}
.stat b{display:block;font-size:22px;color:var(--ink)}.stat span{color:var(--muted);font-size:13px}
.card h3 a{color:var(--ink);text-decoration:none}"""

# The kit's beacon (SPEC §8) is the page's only script, and posts to this site only.
CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"


FOOTER = "Kept up to date by an assistant, published with the owner's approval."


def _page_html(
    v: SiteView, title: str, description: str, main: str, kind: str, id: str = ""
) -> str:
    s = v.site
    links = "".join(f'<a href="{esc(x["url"])}">{esc(x["label"])}</a>' for x in s["links"])
    owner = f"{esc(s['owner_name'])} · " if s.get("owner_name") else ""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'<title>{esc(title)}</title><meta name="description" content="{esc(description)}"><meta property="og:title" content="{esc(title)}">\n'
        f'<meta property="og:description" content="{esc(description)}"><style>{CSS}</style></head>\n'
        f'<body data-kind="{esc(kind)}" data-id="{esc(id)}"><div class="wrap"><header><a class="logo" href="/">{esc(s["title"])}</a><nav>{links}</nav></header><main>{main}</main>\n'
        f"<footer>{owner}{esc(s['footer_line']) if s.get('footer_line') else FOOTER}</footer></div>"
        '<script src="/static/a.js" defer></script></body></html>'
    )


def page(
    v: SiteView,
    title: str,
    description: str,
    main: str,
    kind: str,
    id: str = "",
    origin: str = "",
    provenance=None,
) -> Response:
    return respond(
        finish_embeds(
            _page_html(v, title, description, main, kind, id),
            v.site.get("embed_sources") if origin else [],
            origin,
            provenance,
        ),
        headers={
            "Cache-Control": "no-cache",
            **({"Permissions-Policy": PERMISSIONS} if origin else {}),
        },
        csp=frame_csp(CSP, v.site.get("embed_sources") if origin else [], origin),
    )


def _cover(e: Data, cls: str = "cover", lazy: bool = True) -> str:
    return f'<img class="{cls}" src="{esc(e["cover"])}" alt="{esc(e.get("cover_alt"))}"{' loading="lazy"' if lazy else ""}>'


def _entry_tile(e: Data, stream: Data) -> str:
    cover = f'<a href="{esc(e["url"])}">{_cover(e)}</a>' if e.get("cover") else ""
    summary = f"<p>{esc(e['summary'])}</p>" if e.get("summary") else ""
    out = (
        f'<a href="{esc(e["url"])}">{esc(stream.get("link_label") or "Read")} →</a>'
        if e.get("external_url")
        else ""
    )
    return (
        f'<div class="card">{cover}<div class="meta">{esc(long_date(e["date"]))}</div>'
        f'<h3><a href="{esc(e["url"])}">{esc(e["title"])}</a></h3>{summary}{out}</div>'
    )


def _entry_card(e: Data) -> str:
    cover = f'<a href="{esc(e["url"])}">{_cover(e)}</a>' if e.get("cover") else ""
    summary = f"<p>{esc(e['summary'])}</p>" if e.get("summary") else ""
    return (
        f'<div class="entry">{cover}<div class="meta">{esc(long_date(e["date"]))}</div>'
        f'<h3><a href="{esc(e["url"])}">{esc(e["title"])}</a></h3>{summary}</div>'
    )


def _stream_section(v: SiteView, stream: Data) -> str:
    items = [e for e in v.entries if e["stream"] == stream["id"]][:10]
    if not items:
        return ""
    byline = f'<p class="byline">{esc(stream["byline"])}</p>' if stream.get("byline") else ""
    head = f"<h2>{esc(stream['title'])}</h2>{byline}"
    if stream.get("layout") == "cards":
        tiles = "".join(_entry_tile(e, stream) for e in items)
        return f'<section id="{esc(stream["id"])}">{head}<div class="cards">{tiles}</div></section>'
    return f'<section id="{esc(stream["id"])}">{head}{"".join(_entry_card(e) for e in items)}</section>'


def _card(c: Data) -> str:
    image = (
        f'<img class="cover" src="{esc(c["image"])}" alt="{esc(c.get("image_alt"))}" loading="lazy">'
        if c.get("image")
        else ""
    )
    badge = c.get("badge") if c.get("badge") is not None else c.get("status")
    badge_html = f'<span class="badge">{esc(badge)}</span>' if badge else ""
    link = (
        f'<a href="{esc(c["link"])}">{esc(c.get("link_label") or c["link"])}</a>'
        if c.get("link")
        else ""
    )
    return (
        f'<div class="card">{image}<h3>{esc(c["name"])} {badge_html}</h3>'
        f"<p>{esc(c['description'])}</p>{link}</div>"
    )


def home(v: SiteView, origin: str = "") -> Response:
    s = v.site
    streams: list[Data] = s["streams"]
    named = set(s["sections"])
    sections: dict[str, str] = {
        # "entries" stands for every stream the owner didn't place by name.
        "entries": "".join(_stream_section(v, x) for x in streams if x["id"] not in named),
        **{x["id"]: _stream_section(v, x) for x in streams},
        "cards": f'<section><h2>{esc(s["cards_title"])}</h2><div class="cards">{"".join(_card(c) for c in v.cards)}</div></section>'
        if v.cards
        else "",
        "notes": "<section><h2>"
        + esc(s["notes_title"])
        + '</h2><ul class="notes">'
        + "".join(
            f'<li><span class="meta">{esc(short_date(n["date"]))}</span><span>'
            + (
                f'<a href="{esc(n["link"])}">{esc(n["text"])}</a>'
                if n.get("link")
                else esc(n["text"])
            )
            + "</span></li>"
            for n in v.notes
        )
        + "</ul></section>"
        if v.notes
        else "",
        "about": f"<section><h2>{esc(s['about_title'])}</h2>{markdown(s['about'])}</section>"
        if s.get("about")
        else "",
    }
    hero = (
        f'<img class="hero" src="{esc(s["hero"])}" alt="{esc(s["hero_alt"])}">'
        if s.get("hero")
        else ""
    )
    lede = f'<p class="lede">{esc(s["intro"])}</p>' if s.get("intro") else ""
    main = f"{hero}<h1>{esc(s.get('tagline') or s['title'])}</h1>{lede}" + "".join(
        sections.get(k, "") for k in s["sections"]
    )
    return page(
        v, s["title"], s.get("tagline") or u16slice(s["intro"], 0, 160), main, "home", origin=origin
    )


def entry_page(v: SiteView, address: str, origin: str = "") -> Response | None:
    """An entry's page, at its address (/<stream path>/<slug>/)."""
    e = next((x for x in v.entries if x["page"] == address), None)
    if not e:
        return None
    # A post that lives elsewhere has no page here; its address goes there.
    if e.get("external_url"):
        return redirect(e["external_url"], 302)
    summary = f'<p class="lede">{esc(e["summary"])}</p>' if e.get("summary") else ""
    cover = _cover(e, lazy=False) if e.get("cover") else ""
    stats = e.get("stats") or []
    stats_html = (
        '<div class="stats">'
        + "".join(
            f'<div class="stat"><b>{esc(x["value"])}</b><span>{esc(x["label"])}</span></div>'
            for x in stats
        )
        + "</div>"
        if stats
        else ""
    )
    tags = (
        '<p class="tags">'
        + "".join(f'<span class="meta">#{esc(t)}</span> ' for t in e["tags"])
        + "</p>"
        if e["tags"]
        else ""
    )
    body = body_markdown(e["body"])
    main = (
        f'<article><p class="meta"><a href="/">← {esc(v.site["title"])}</a></p>'
        f'<div class="meta">{esc(long_date(e["date"]))}</div><h1>{esc(e["title"])}</h1>'
        f"{summary}{cover}{stats_html}{body}{tags}</article>"
    )
    return page(
        v,
        f"{e['title']} · {v.site['title']}",
        e.get("summary") or e["title"],
        main,
        "entry",
        e["id"],
        origin,
        body,
    )


_SEG = re.compile(rf"^/([a-z][a-z0-9-]{{0,29}})(/{DOT}*)?\Z")
_ARCH = re.compile(r"^/([a-z][a-z0-9-]{0,29})/(?:tags/[a-z0-9-]{1,30}/)?\Z")


def redirect_for(v: SiteView, path: str) -> str | None:
    """Where a missing page lives now, or None. Two cases: the address lacks
    its trailing slash, or it names a stream by its id after the stream moved
    to another path (/journal/x/ once the journal lives at /reports/). Only real
    pages are answered, so nothing else on the site can be redirected."""
    streams: list[Data] = v.site["streams"]
    to = path
    seg = _SEG.search(to)
    moved = (
        next(
            (
                x
                for x in streams
                if x["id"] == seg.group(1) and (x.get("path") or x["id"]) != x["id"]
            ),
            None,
        )
        if seg
        else None
    )
    if moved and seg and not any((x.get("path") or x["id"]) == seg.group(1) for x in streams):
        to = f"/{moved['path']}{seg.group(2) if seg.group(2) is not None else '/'}"
    if not to.endswith("/"):
        to += "/"
    if to == path:
        return None
    paths = {x.get("path") or x["id"] for x in streams}
    arch = _ARCH.search(to)
    real = bool(arch and arch.group(1) in paths) or any(e["page"] == to for e in v.entries)
    return to if real else None


def not_found(v: SiteView, origin: str = "") -> Response:
    title = esc(v.site["title"])
    t = strings_of(v.site)
    body = _page_html(
        v,
        f"{t['not_found_title']} · {v.site['title']}",
        "",
        f'<h1>{esc(t["not_found_title"])}</h1><p><a href="/">{title}</a></p>',
        "notfound",
    )
    return respond(
        body,
        status=404,
        headers={
            "Cache-Control": "no-store",
            **({"Permissions-Policy": PERMISSIONS} if origin else {}),
        },
        csp=frame_csp(CSP, v.site.get("embed_sources") if origin else [], origin),
    )
