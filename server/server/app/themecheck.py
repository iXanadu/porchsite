"""The template rules (TEMPLATES.md §2) as far as a machine can check them.
Used by the site itself (theme_create), so an assistant's own look meets the
same bar as a reviewed one. Assistant-made looks may not carry scripts at
all. Port of cloudflare/src/themecheck.ts. Regular expressions keep
JavaScript's meaning: \\s is Unicode whitespace (jsutil.S), \\b and \\w ASCII.
"""

import re
from datetime import datetime
from typing import Any

from server.spec import mustache
from server.spec import theme as views
from server.spec.blocks import palette_problems
from server.spec.jsutil import S, url_host
from server.spec.sample import sample_view as _sample_view

from .theme import Theme, render

PAGES = ["home", "entry", "archive", "tag", "not_found"]
ALLOWED_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"]
# An X handle, without the @: X's own rule (1 to 15 letters, digits or underscores).
X_HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}\Z", re.ASCII)
# Credit is an X handle and nothing else: no names, emails or links.
_OTHER_AUTHOR = re.compile(
    r"^(author|creator|contact|e-?mail|homepage|website|url|twitter)(_|\Z)", re.ASCII | re.I
)

_A = re.ASCII
_I = re.ASCII | re.I
_SC = S[1:-1]  # the whitespace characters, for use inside [...]
_URL = re.compile(rf"https?://[^{_SC}\"'<>)]+", _A)
_ANY = r"[\s\S]"  # any character, newlines included


def _host(u: str) -> str:
    h = url_host(u)
    return u if h is None else h


def _falsy(v: Any) -> bool:
    """JavaScript's !v."""
    if v is None or v is False or v == "":
        return True
    return isinstance(v, int | float) and not isinstance(v, bool) and (v == 0 or v != v)


def rules(name: str, t: Theme, scripts: bool) -> list[str]:
    """Problems with a theme's files, or [] when it's sound."""
    problems: list[str] = []
    m = t.get("manifest") or {}

    def need(ok: Any, msg: str) -> None:
        if _falsy(ok):
            problems.append(msg)

    def s(v: Any) -> str:
        return "undefined" if v is None else str(v)

    need(m.get("name") == name, f'template.json name is "{s(m.get("name"))}", not "{name}"')
    need(re.search(r"^[a-z][a-z0-9-]{0,39}\Z", name), "name: lowercase letters, digits and dashes")
    need(isinstance(m.get("title"), str) and m["title"], "template.json needs a title")
    need(re.search(r"^\d+\.\d+\.\d+\Z", s(m.get("version")), _A), "version must look like 1.0.0")
    need(
        re.search(r"^[a-z][a-z0-9-]{1,29}\Z", str(m.get("type") or "")),
        "type: what the site is for, e.g. personal, product, business",
    )
    need(
        isinstance(m.get("description"), str) and len(m["description"]) >= 20,
        "description: a sentence or two for people choosing a look",
    )
    art = m.get("art")
    need(
        isinstance(art, dict)
        and not _falsy(art.get("ask"))
        and not _falsy(art.get("style"))
        and isinstance(art.get("steps"), list)
        and len(art["steps"]) > 0,
        "art: ask, style and steps are required",
    )
    if "author_x" in m:
        need(
            isinstance(m["author_x"], str) and X_HANDLE.search(m["author_x"]),
            "author_x: an X handle without the @ (1 to 15 letters, digits or underscores)",
        )
    for k in m:
        if k != "author_x" and _OTHER_AUTHOR.search(k):
            problems.append(
                f"{k}: credit is an X handle in author_x and nothing else (no names, emails or links)"
            )
    for sl in (m.get("slots") or {}).get("images") or []:
        f = s(sl.get("field"))
        size = sl.get("size")
        need(
            isinstance(size, list)
            and len(size) == 2
            and all(isinstance(n, int | float) and not isinstance(n, bool) and n > 0 for n in size),
            f"image slot {f}: size [width, height]",
        )
        need(
            sl.get("need") in ("required", "recommended", "optional"),
            f"image slot {f}: need is required, recommended or optional",
        )
        need(sl.get("purpose"), f"image slot {f}: say what it's for")
    problems.extend(palette_problems(m["palettes"] if "palettes" in m else ...))
    pages = t.get("pages") or {}
    static = t.get("static") or {}
    for p in PAGES:
        need(isinstance(pages.get(p), str), f"missing {p}.mustache")
    need(isinstance(static.get("site.css"), str), "missing static/site.css")
    for f in static:
        if not re.search(r"^[a-z0-9][a-z0-9._-]{0,60}\Z", f):
            problems.append(
                f"static/{f}: file names are lowercase letters, digits, dots and dashes"
            )
        elif not scripts and not f.endswith(".css"):
            problems.append(
                f"static/{f}: only stylesheets (.css); a look made by an assistant carries no scripts"
            )
    sources: dict[str, str] = {}
    for k, v in pages.items():
        sources[f"{k}.mustache"] = v
    for k, v in (t.get("partials") or {}).items():
        sources[f"partials/{k}.mustache"] = v
    for file, src in sources.items():
        try:
            mustache.parse(src)
        except Exception as e:  # mustache.js throws Error
            problems.append(f"{file}: {e}")
        # Conditional attributes begin with whitespace and leave a name
        # boundary even when omitted; they cannot change the tag name.
        names = re.sub(
            r"(</?[a-z][a-z0-9:-]*)\{\{[#^]\s*([a-zA-Z0-9_.-]+)\s*\}\}[ \t\r\n]+[^<>]*?\{\{/\s*\2\s*\}\}(?=[ \t\r\n/>])",
            r"\1 ",
            src,
            flags=_I,
        )
        if re.search(r"</?[^\s/>]*\{\{", names):
            problems.append(f"{file}: tag names must be literal HTML")
        if re.search(r"\{\{=", src):
            problems.append(f"{file}: delimiter changes aren't allowed")
        for tri in re.findall(r"\{\{\{[^}]*\}\}\}", src):
            if not re.search(rf"_html{S}*\}}\}}\}}\Z", tri):
                problems.append(f"{file}: triple braces only for *_html values ({tri})")
        if re.search(r"\{\{&", src):
            problems.append(f"{file}: {{{{& }}}} (unescaped) isn't allowed")
        if re.search(r"<script(?![^>]*\bsrc=)[^>]*>", src, _I):
            problems.append(f"{file}: inline <script>; load scripts from static/ with src")
        # The site's own scripts (kit.*_url) are fine anywhere; a look made by an assistant brings none of its own.
        if not scripts:
            for tag in re.findall(r"<script\b[^>]*>", src, _I):
                if not re.search(r'\bsrc="\{\{kit\.[a-z_]+_url\}\}"', tag, _A):
                    problems.append(
                        f"{file}: scripts only from the site's kit ({{{{kit.*_url}}}}); a look made by an assistant carries none of its own"
                    )
        if re.search(rf"{S}on[a-z]+{S}*=", src, _I):
            problems.append(f"{file}: inline event handlers (onclick=…) aren't allowed")
        if re.search(r"<(iframe|object|embed|form|porchsite-embed)\b", src, _I):
            problems.append(f"{file}: no iframes, objects, embeds or forms")
        for img in re.findall(r"<img\b[^>]*>", src, _I):
            if not re.search(r'\balt="', img, _A):
                problems.append(f"{file}: <img> without alt from the view")
        for u in _URL.findall(src):
            if _host(u) not in ALLOWED_HOSTS:
                problems.append(f"{file}: outside address {u}")
        text = re.sub(rf"<!--{_ANY}*?-->", "", src)
        text = re.sub(rf"<(script|style){_ANY}*?</\1>", "", text, flags=_I)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(rf"\{{\{{{_ANY}*?\}}\}}", " ", text)
        words = re.findall(r"[A-Za-z]{2,}", text)
        if words:
            problems.append(
                f"{file}: fixed words ({', '.join(list(dict.fromkeys(words))[:6])}); take them from the view"
            )
    for f, css in static.items():
        for u in _URL.findall(css):
            if _host(u) not in ALLOWED_HOSTS:
                problems.append(f"static/{f}: outside address {u}")
        if f.endswith(".css") and re.search(
            rf"@import{S}+(?!url\({S}*[\"']?https://fonts\.googleapis\.com)", css, _I
        ):
            problems.append(f"static/{f}: @import only for Google Fonts")
        if f.endswith(".css") and re.search(
            rf"expression\(|javascript:|(?<![-\w])behavior{S}*:", css, _I
        ):
            problems.append(f"static/{f}: no CSS expressions or javascript: URLs")
    return problems


def sample_view(t: Theme, sample: dict[str, Any], now: datetime | None = None):
    """A sample site's view, as the site itself would build it."""
    return _sample_view(str(t["manifest"].get("name")), sample, now)


def render_sample(
    t: Theme, sample: dict[str, Any], o: str = "https://example.com", now: datetime | None = None
) -> dict[str, str]:
    """Every page of a sample site: home, each entry, each stream's archive and tag pages, the 404."""
    v = sample_view(t, sample, now)
    out = {"index.html": render(t, "home", views.home_view(v, "1", o))}
    for e in v.entries:
        if not e.get("external_url"):
            out[f"{str(e['page'])[1:]}index.html"] = render(
                t, "entry", views.entry_view(v, e, "1", o)
            )
    for st in views.streams(v.site):
        path = re.sub(r"^/|/$", "", str(st["archive_url"]))
        av = views.archive_view(v, path, "1", o)
        if av:
            out[f"{path}/index.html"] = render(t, "archive", av)
        tags = dict.fromkeys(
            tag for e in v.entries if e["stream"] == st["id"] for tag in (e.get("tags") or [])
        )
        for tag in tags:
            out[f"{path}/tags/{tag}/index.html"] = render(
                t, "tag", views.archive_view(v, path, "1", o, tag)
            )
    out["404.html"] = render(t, "not_found", views.not_found_view(v, "1", o))
    return out


def check(name: str, t: Theme, sample: Any, scripts: bool) -> list[str]:
    """The rules, then the sample rendered: every page must come out whole."""
    problems = rules(name, t, scripts)
    if not isinstance(sample, dict):
        problems.append("sample.json: generic sample content (no real person) for previews")
    if problems:
        return problems
    try:
        for p, html in render_sample(t, sample).items():
            if "{{" in html:
                problems.append(f"{p}: unrendered {{{{ in output")
    except Exception as e:
        problems.append(f"the sample site doesn't render: {e}")
    return problems
