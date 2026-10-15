"""Rendering a theme held as data ({manifest, pages, partials, static}), as
the Cloudflare edition holds every theme (cloudflare/src/theme.ts render and
staticFile). The views themselves come from server/spec/theme.py, the
line-by-line port, so pages come out byte for byte the same.
"""

import re
from pathlib import Path
from typing import Any

from server.spec import mustache
from server.spec.blocks import palette_css
from server.spec.embeds import finish_embeds
from server.spec.jsutil import S, short_date, string, trim, u16slice
from server.spec.site import SiteView
from server.spec.theme import escape, streams

from .db import dumps

# The site kit's analytics beacon, the same bytes as cloudflare/src/beacon.ts.
BEACON_JS = Path(__file__).with_name("beacon.js").read_text(encoding="utf-8")

Theme = dict[str, Any]
Data = dict[str, Any]

STATIC_TYPES = {"css": "text/css; charset=utf-8", "js": "text/javascript; charset=utf-8"}

_writer = mustache.Writer(escape)


def render(t: Theme, page: str, view: dict[str, Any], policy=None) -> str:
    return finish_embeds(
        _writer.render(t["pages"][page], view, t.get("partials") or {}),
        (policy or {}).get("sources"),
        (policy or {}).get("origin", ""),
        view,
    )


def static_file(t: Theme, file: str, palette: str = "") -> dict[str, Any] | None:
    """A theme's static file: {"body": str, "headers": {...}}, or None. The
    site's palette goes after the theme's stylesheet, so its colours win."""
    # The beacon is the kit's, never a theme's own.
    own = BEACON_JS if file == "a.js" else (t.get("static") or {}).get(file)
    if own is None:
        return None
    body = own + palette_css(t["manifest"].get("palettes"), palette) if file == "site.css" else own
    return {
        "body": body,
        "headers": {
            "Content-Type": STATIC_TYPES.get(file.split(".")[-1], "text/plain; charset=utf-8"),
            "Cache-Control": "public, max-age=3600",
            "X-Content-Type-Options": "nosniff",
        },
    }


def _xml(v: Any) -> str:
    return escape(string(v))


def feed(v: SiteView, stream_path: str, origin: str) -> dict[str, Any] | None:
    """A stream's Atom feed: its newest 20 entries (feeds belong to the site,
    not the theme). {"body", "headers"}, or None for no such stream."""
    stream = next((x for x in streams(v.site) if x["path"] == stream_path), None)
    if not stream:
        return None
    items = [e for e in v.entries if e["stream"] == stream["id"]][:20]
    updated = f"{items[0]['date']}T12:00:00Z" if items else "1970-01-01T00:00:00.000Z"
    handle = f"@{v.site['handle']}" if v.site.get("handle") else ""
    # An assistant's stream is "<assistant> for @owner"; the owner's own is "@owner".
    if stream["author"]:
        author = f"{stream['author']} for {handle}" if handle else stream["author"]
    else:
        author = handle or v.site.get("owner_name") or v.site["title"]
    if stream["feed_subtitle"]:
        subtitle = (
            f"{stream['feed_subtitle']}, {stream['byline']}."
            if stream["author"] and stream["byline"]
            else stream["feed_subtitle"]
        )
    else:
        subtitle = stream["byline"]
    entries = ""
    for e in items:
        url = e.get("external_url") or f"{origin}{e['url']}"
        entries += (
            f'<entry>\n<title>{_xml(e["title"])}</title>\n<link href="{_xml(url)}"/>\n'
            f"<id>{_xml(url)}</id>\n<updated>{e['date']}T12:00:00Z</updated>\n"
            f"<summary>{_xml(e.get('summary'))}</summary>\n</entry>\n"
        )
    body = (
        '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n'
        f"<title>{_xml(stream['nav_label'])} · {_xml(v.site['title'])}</title>\n"
        + (f"<subtitle>{_xml(subtitle)}</subtitle>\n" if subtitle else "")
        + f'<link href="{origin}{stream["feed_url"]}" rel="self"/>\n'
        f'<link href="{origin}{stream["archive_url"]}"/>\n'
        f"<id>{origin}{stream['archive_url']}</id>\n<updated>{updated}</updated>\n"
        f"<author><name>{_xml(author)}</name></author>\n{entries}</feed>\n"
    )
    return {
        "body": body,
        "headers": {
            "Content-Type": "application/atom+xml; charset=utf-8",
            "Cache-Control": "public, max-age=300",
        },
    }


_STRIP = re.compile(r"[#*_`>\[\]()!-]")
_SPACES = re.compile(f"{S}+")


def search_index(v: SiteView, stream_path: str) -> dict[str, Any] | None:
    """What a stream's search box filters in the browser (the classic format)."""
    stream = next((x for x in streams(v.site) if x["path"] == stream_path), None)
    if not stream:
        return None
    rows = [
        {
            "t": e["title"],
            "s": e.get("summary"),
            "g": e.get("tags") if e.get("tags") is not None else [],
            "u": e["url"],
            "d": short_date(e["date"]),
            "l": (stream["link_label"] or "Read") if e.get("external_url") else "",
            "x": bool(e.get("external_url")),
            "b": u16slice(trim(_SPACES.sub(" ", _STRIP.sub(" ", string(e.get("body"))))), 0, 4000),
        }
        for e in v.entries
        if e["stream"] == stream["id"]
    ]
    return {
        "body": dumps(rows),
        "headers": {"Content-Type": "application/json", "Cache-Control": "public, max-age=60"},
    }
