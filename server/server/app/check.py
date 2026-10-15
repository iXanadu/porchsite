"""site_check: the site as it will be once everything staged is published,
looked over the way a visitor would click through it (SPEC §4). Links
inside the site that lead nowhere (a page, a section, a picture) and
sections in the layout with nothing in them. Port of cloudflare/src/check.ts.
"""

import re
from html.parser import HTMLParser
from uuid import uuid4
from urllib.parse import urljoin, urlsplit
from typing import Any

from server.spec.jsutil import string, trim
from server.spec.site import SiteView
from server.spec import theme as views
from server.spec.theme import streams

from . import builtin, themes
from .theme import Theme, render

Data = dict[str, Any]

# Addresses every site answers that aren't content.
FIXED = {"/", "/review/", "/login/", "/robots.txt", "/sitemap.xml"}
MD_LINK = re.compile(r"\]\(\s*(/[^)\s]*)")


def _links_of(where: str, data: Data, fields: list[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []

    def add(field: str, v: Any) -> None:
        if isinstance(v, str) and v.startswith("/") and not v.startswith("//"):
            out.append((f"{where} {field}", v))

    for f in fields:
        v = data.get(f)
        if isinstance(v, str):
            add(f, v)
            for m in MD_LINK.finditer(v):
                add(f, m.group(1))
    return out


def check_site(v: SiteView, media: set[str], look: Theme | None = None, origin: str = "https://example.invalid") -> Data:
    s = v.site
    st = streams(s)
    pages = set(FIXED)
    for x in st:
        pages.add(x["archive_url"])
        pages.add(x["feed_url"])
    for e in v.entries:
        x = next((y for y in st if y["id"] == e["stream"]), st[0])
        if not e.get("external_url"):
            pages.add(e["page"])
        for t in e.get("tags") or []:
            pages.add(f"{x['archive_url']}tags/{t}/")

    # The home page's sections, in the owner's order, and which have something in them.
    sections: list[str] = s["sections"]
    order = [
        y
        for k in sections
        for y in ([x["id"] for x in st if x["id"] not in sections] if k == "entries" else [k])
    ]
    anchors: set[str] = set()
    empty: list[str] = []
    for k in order:
        x = next((y for y in st if y["id"] == k), None)
        if k == "cards":
            filled = len(v.cards) > 0
        elif k == "about":
            filled = bool(trim(string(s.get("about") or "")))
        elif k == "notes":
            filled = len(v.notes) > 0
        else:
            filled = any(e["stream"] == k for e in v.entries)
        anchor = x["anchor"] if x else (s.get("cards_anchor") or "cards") if k == "cards" else k
        if filled:
            anchors.add(anchor)
        else:
            empty.append(f"{x['title']} ({k})" if x else k)

    links = [
        *_links_of("site", s, ["cta_link", "cta2_link", "intro", "about"]),
        *[
            p
            for i, ln in enumerate(s.get("links") or [])
            for p in _links_of(f"site links[{i}]", ln, ["url"])
        ],
        *[
            p
            for i, b in enumerate(s.get("buttons") or [])
            for p in _links_of(f"site buttons[{i}]", b, ["url"])
        ],
        *[
            p
            for e in v.entries
            for p in _links_of(f"entry {e['id']}", e, ["body", "summary", "cover"])
        ],
        *[
            p
            for c in v.cards
            for p in _links_of(f"card {c['id']}", c, ["link", "description", "image"])
        ],
        *[p for n in v.notes for p in _links_of(f"note {n['id']}", n, ["link"])],
    ]
    broken: list[Data] = []
    for where, link in links:
        rest, _, hash_ = link.partition("#")
        path = rest.split("?", 1)[0] or "/"
        if path.startswith("/media/"):
            if path[len("/media/") :] not in media:
                broken.append(
                    {"where": where, "link": link, "why": "this site has no picture by that name"}
                )
            continue
        if path.startswith("/static/"):
            continue
        page = path if path.endswith("/") or re.search(r"\.[a-z]+$", path) else f"{path}/"
        if page not in pages:
            broken.append({"where": where, "link": link, "why": "no page at that address"})
            continue
        if hash_ and page == "/" and hash_ not in anchors:
            broken.append(
                {
                    "where": where,
                    "link": link,
                    "why": f"the home page has no section #{hash_} with anything in it",
                }
            )
    # Empty sections are reported, not failed: the site's menu leaves them out.
    unreachable = _unreachable_entries(v, look, origin)
    return {"ok": not broken and not unreachable, "broken": broken, "empty_sections": empty, "unreachable": unreachable}


class _Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []
        self.comments: list[str] = []

    def handle_comment(self, data: str) -> None:
        self.comments.append(data)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("a", "area"):
            href = dict(attrs).get("href")
            if href is not None:
                self.links.append(href)


def _unreachable_entries(v: SiteView, look: Theme | None, origin: str) -> list[Data]:
    t = look or themes.built_in().get(themes.ALIASES.get(v.site["theme"], v.site["theme"]))
    origin = origin or "https://example.invalid"
    base = urlsplit(origin)
    reached: set[str] = set()
    inline: set[str] = set()
    marker = f"porchsite-check-{uuid4()}:"
    indexes = {e["id"]: i for i, e in enumerate(v.entries)}

    def marked(value: Any) -> Any:
        if isinstance(value, list):
            return [marked(x) for x in value]
        if not isinstance(value, dict):
            return value
        out = {k: marked(val) for k, val in value.items()}
        i = indexes.get(value.get("id"))
        if i is not None and value.get("body_html"):
            out["body_html"] = f"<!--{marker}{i}-->{value['body_html']}"
        return out

    visited: set[str] = set()
    queue = ["/"]
    while queue:
        path = queue.pop(0)
        if path in visited:
            continue
        visited.add(path)
        old = re.fullmatch(r"/e/([a-z0-9-]+)/?", path)
        moved = next((e["page"] for e in v.entries if old and e["slug"] == old[1]), None) if old else builtin.redirect_for(v, path)
        if moved:
            queue.append(moved)
            continue
        e = next((e for e in v.entries if e["page"] == path), None)
        if e and e.get("external_url"):
            reached.add(urljoin(origin, e["external_url"]))
            continue
        body = None
        if t:
            if path == "/":
                body = render(t, "home", marked(views.home_view(v, "check", origin)))
            elif e:
                body = render(t, "entry", marked(views.entry_view(v, e, "check", origin)))
            else:
                arch = re.fullmatch(r"/([a-z][a-z0-9-]{0,29})/(?:tags/([a-z0-9-]{1,30})/)?", path)
                av = views.archive_view(v, arch[1], "check", origin, arch[2]) if arch else None
                if av:
                    body = render(t, "tag" if arch[2] else "archive", marked(av))
        else:
            response = builtin.home(v) if path == "/" else builtin.entry_page(v, path)
            if response:
                body = response.body.decode("utf-8")
        if body is None:
            continue
        parser = _Links()
        parser.feed(re.sub(r"<template\b[^>]*>[\s\S]*?</template\s*>", "", body, flags=re.I))
        for comment in parser.comments:
            if comment.startswith(marker) and comment[len(marker):].isdigit():
                i = int(comment[len(marker):])
                if i < len(v.entries):
                    inline.add(v.entries[i]["id"])
        for href in parser.links:
            try:
                url = urljoin(urljoin(origin, path), href)
                parts = urlsplit(url)
                if parts.scheme not in ("http", "https"):
                    continue
                reached.add(url)
                if (parts.scheme, parts.netloc) == (base.scheme, base.netloc):
                    queue.append(parts.path or "/")
            except ValueError:
                continue
    return [
        {"id": e["id"], "why": "no rendered link path from the home page to this entry"}
        for e in v.entries
        if e["id"] not in inline and e["page"] not in visited and (not e.get("external_url") or urljoin(origin, e["external_url"]) not in reached)
    ]
