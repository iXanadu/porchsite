"""Engine-owned embed blocks; live policy is applied after template selection."""

import re
import uuid
from urllib.parse import quote, unquote

from .embed_url import embed_sources, embed_url, request_origin
from .html import esc, markdown
from .jsutil import trim

_FORM = re.compile(r"!embed\[([^\[\]\r\n]{1,200})\]\(([^()\r\n]{1,2000})\)\Z")
PERMISSIONS = "camera=(), microphone=(), geolocation=(), payment=(), display-capture=(), publickey-credentials-get=()"


class _Body(str):
    """String-compatible HTML with private capabilities, never view fields."""

    def __new__(cls, value, markers):
        obj = super().__new__(cls, value)
        obj._markers = markers
        return obj


def _render_markers(view, out=None, seen=None):
    out = {} if out is None else out
    seen = set() if seen is None else seen
    if isinstance(view, _Body):
        out.update(view._markers)
    elif isinstance(view, (dict, list)) and id(view) not in seen:
        seen.add(id(view))
        for value in view.values() if isinstance(view, dict) else view:
            _render_markers(value, out, seen)
    return out


def embed_line(line):
    m = _FORM.fullmatch(line)
    if not m or not trim(m[1]) or any(0xD800 <= ord(c) <= 0xDFFF for c in m[1]):
        return None
    try:
        u = embed_url(m[2])
    except (ValueError, UnicodeError):
        return None
    if len(m[1].encode("utf-16-le", errors="surrogatepass")) // 2 > 200:
        return None
    return {"url": u.href, "title": m[1], "origin": u.origin}


def body_markdown(src, visit=None, heading_ids=False, body_h1_as_h2=False):
    if "!embed[" not in src:
        return markdown(src, heading_ids=heading_ids, body_h1_as_h2=body_h1_as_h2)

    markers = {}

    def block(line):
        e = embed_line(line)
        if not e:
            return None
        if visit:
            visit(e)
        key = str(uuid.uuid4())
        markers[key] = e
        url = quote(e["url"], safe="-_.!~*'()")
        title = quote(e["title"], safe="-_.!~*'()")
        return f'<porchsite-embed data-key="{key}" data-url="{url}" data-title="{title}"></porchsite-embed>'

    html = markdown(src, block, heading_ids, body_h1_as_h2)
    return _Body(html, markers) if markers else html


def heading_bodies(value, heading_ids=True, body_h1_as_h2=False, bodies=None):
    """Rebuild each Markdown source once, keeping its private engine capabilities."""
    bodies = {} if bodies is None else bodies
    if isinstance(value, list):
        return [heading_bodies(child, heading_ids, body_h1_as_h2, bodies) for child in value]
    if not isinstance(value, dict):
        return value
    out = {}
    for key, child in value.items():
        if key == "body_html" and child and isinstance(value.get("body"), str):
            source = value["body"]
            if source not in bodies:
                bodies[source] = body_markdown(
                    source, heading_ids=heading_ids, body_h1_as_h2=body_h1_as_h2
                )
            out[key] = bodies[source]
        else:
            out[key] = heading_bodies(child, heading_ids, body_h1_as_h2, bodies)
    return out


def embeds_of(src):
    out = []
    if "!embed[" in src:
        body_markdown(src, out.append)
    return out


def safe_sources(values, origin=""):
    if not isinstance(values, list):
        return []
    try:
        return [s for s in embed_sources(values) if s != request_origin(origin)]
    except (ValueError, TypeError, UnicodeError):
        return []


def frame_csp(csp, sources, origin):
    values = safe_sources(sources, origin)
    return csp + (f"; frame-src {' '.join(values)}" if values else "")


_MARKER = re.compile(
    r'<porchsite-embed(?: data-key="([a-f0-9-]{36})")? data-url="([^"]*)" data-title="([^"]*)"></porchsite-embed>\Z'
)
_TOKENS = re.compile(
    r"""<porchsite-embed(?: data-key="[a-f0-9-]{36}")? data-url="[^"]*" data-title="[^"]*"></porchsite-embed>|<!--[\s\S]*?(?:-->|$)|<(?:"[^"]*"|'[^']*'|[^'">])*>"""
)
_TAG = re.compile(r"<\s*(/?)\s*([a-z0-9-]+)", re.I)


def _without_authored_frames(body):
    # Independent of malformed comments; spaces prevent joining tag fragments.
    inert = re.sub(
        r"(</?)(iframe|object|embed|frame)\b", r"\1porchsite-inert-\2", str(body), flags=re.I
    )

    def replace(match):
        tag = match[0]
        if tag.startswith("</"):
            return " "
        attr = re.search(
            r"""\b(?:src|data|cite)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", tag, re.I
        )
        if attr:
            try:
                u = embed_url(next(v for v in attr.groups() if v is not None))
                return f'<a href="{esc(u.href)}">{esc(u.href)}</a>'
            except (ValueError, UnicodeError):
                pass
        return " "

    return re.sub(
        r"""</?porchsite-inert-(?:iframe|object|embed|frame)\b(?:"[^"]*"|'[^']*'|[^'">])*(?:>|$)""",
        replace,
        inert,
        flags=re.I,
    )


def finish_embeds(body, sources=None, origin="", view=None):
    view = body if view is None else view
    body = _without_authored_frames(body)
    if "<porchsite-embed " not in body:
        return body
    markers = _render_markers(view)
    allowed = set(safe_sources(sources or [], origin))
    count, templates, noscript, raw_text = 0, 0, False, ""

    def replace(match):
        nonlocal count, templates, noscript, raw_text
        token = match[0]
        tag = _TAG.match(token)
        if raw_text:
            if tag and tag[1] and tag[2].lower() == raw_text:
                raw_text = ""
            return token
        if token.startswith("<!--"):
            return token
        marker = _MARKER.fullmatch(token)
        if marker:
            e = markers.get(marker[1]) if marker[1] else None
            genuine = e is not None
            if e is None and marker:
                try:
                    u = embed_url(unquote(marker[2]))
                    e = {"url": u.href, "title": unquote(marker[3]), "origin": u.origin}
                except (ValueError, UnicodeError):
                    return ""
            if e is None:
                return ""
            u = embed_url(e["url"])
            title = e["title"]
            link = f'<a href="{esc(u.href)}">{esc(title)}</a>'
            if not genuine or templates or noscript or u.origin not in allowed or count >= 12:
                return f'<div class="embed">{link}</div>'
            count += 1
            return f'<div class="embed"><iframe src="{esc(u.href)}" title="{esc(title)}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen; xr-spatial-tracking" style="width:100%;aspect-ratio:16/9;border:0"></iframe>{link}</div>'
        if noscript:
            if tag and tag[1] and tag[2].lower() == "noscript":
                noscript = False
            return token
        if tag:
            name = tag[2].lower()
            if name == "noscript" and not tag[1]:
                noscript = True
            if name == "template":
                templates = max(0, templates + (-1 if tag[1] else 1))
            if not tag[1] and name in (
                "script",
                "style",
                "textarea",
                "title",
                "xmp",
                "iframe",
                "noembed",
                "noframes",
            ):
                raw_text = name
        return token

    return _TOKENS.sub(replace, body)


def embed_notes(entries, sources, origin):
    live = set(safe_sources(sources, origin))
    return [
        {
            "id": e["id"],
            "url": b["url"],
            "origin": b["origin"],
            "note": "Use a source on another site; this source is this site's own origin."
            if b["origin"] == request_origin(origin)
            else "Ask the owner to approve this embed source.",
        }
        for e in entries
        for b in embeds_of(e.get("body") or "")
        if b["origin"] not in live
    ]
