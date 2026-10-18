"""site_check: the site as it will be once everything staged is published,
looked over the way a visitor would click through it (SPEC §4). Links
inside the site that lead nowhere (a page, a section, a picture) and
sections in the layout with nothing in them. Port of cloudflare/src/check.ts.
"""

import re
from html.parser import HTMLParser
from uuid import uuid4
from urllib.parse import urljoin, urlsplit, urlunsplit
from typing import Any, Callable

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


def check_site(v: SiteView, media: set[str]) -> Data:
    s = v.site
    st = streams(s)
    pages = set(FIXED)
    if s.get("archive", {}).get("enabled"):
        pages.add("/archive/")
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
    return {"ok": not broken, "broken": broken, "empty_sections": empty}


def check_site_deep(v: SiteView, media: set[str], look: Theme | None = None, origin: str = "https://example.invalid") -> Data:
    quick = check_site(v, media)
    broken, empty = quick["broken"], quick["empty_sections"]
    unreachable, crawl = _unreachable_entries(v, look, origin)
    return {"ok": not broken and not unreachable and not crawl, "broken": broken, "empty_sections": empty, "unreachable": unreachable, **({"crawl": crawl} if crawl else {})}


MAX_PAGES = 200
MAX_LINKS = 10_000


class _Links(HTMLParser):
    """Consume link and body proofs in document order, stopping at completion."""
    def __init__(self, remaining: int, link: Callable[[str], bool], comment: Callable[[str], bool]) -> None:
        super().__init__(convert_charrefs=True)
        self.link = link
        self.comment = comment
        self.links = 0
        self.template_depth = 0
        self.remaining = remaining
        self.limited = False
        self.complete = False

    def handle_comment(self, data: str) -> None:
        if not self.template_depth and not self.limited and not self.complete:
            self.complete = self.comment(data)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.limited or self.complete:
            return
        if tag == "template":
            self.template_depth += 1
        if not self.template_depth and tag in ("a", "area"):
            href = dict(attrs).get("href")
            if href is not None:
                if self.links == self.remaining:
                    self.limited = True
                else:
                    self.links += 1
                    self.complete = self.link(href)

    def handle_endtag(self, tag: str) -> None:
        if tag == "template" and self.template_depth:
            self.template_depth -= 1

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # A self-closing slash does not close non-void HTML template elements.
        self.handle_starttag(tag, attrs)


def _address(href: str, base: str) -> str:
    """Normalise HTTP destinations as new URL does: case, port and empty path."""
    parts = urlsplit(urljoin(base, href))
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        return urlunsplit((scheme, parts.netloc, parts.path, parts.query, parts.fragment))
    if not parts.hostname:
        raise ValueError("not an HTTP address")
    host = parts.hostname.encode("idna").decode("ascii").lower()
    if ":" in host:
        host = f"[{host}]"
    if parts.port is not None and parts.port != (443 if scheme == "https" else 80):
        host += f":{parts.port}"
    credentials = parts.netloc.rsplit("@", 1)[0] + "@" if "@" in parts.netloc else ""
    return urlunsplit((scheme, credentials + host, parts.path or "/", parts.query, parts.fragment))


def _unreachable_entries(v: SiteView, look: Theme | None, origin: str) -> tuple[list[Data], Data | None]:
    t = look or themes.built_in().get(themes.ALIASES.get(v.site["theme"], v.site["theme"]))
    base = urlsplit(_address(origin or "https://example.invalid", "https://example.invalid"))
    # Renderer contexts receive an origin, never a URL path or trailing slash.
    origin = urlunsplit((base.scheme, base.netloc, "", "", ""))
    remaining = {e["id"] for e in v.entries}
    if not remaining:
        return [], None
    by_page = {e["page"]: e for e in v.entries}
    by_slug = {e["slug"]: e for e in v.entries}
    external: dict[str, list[str]] = {}
    for e in v.entries:
        if e.get("external_url"):
            external.setdefault(_address(e["external_url"], origin), []).append(e["id"])

    def moved_path(path: str) -> str | None:
        old = re.fullmatch(r"/e/([a-z0-9-]+)/?", path)
        return by_slug.get(old[1], {}).get("page") if old else builtin.redirect_for(v, path)

    def target(path: str) -> Data | None:
        seen: set[str] = set()
        while path not in seen:
            seen.add(path)
            old = re.fullmatch(r"/e/([a-z0-9-]+)/?", path)
            if old:
                entry = by_slug.get(old[1])
                if not entry or entry.get("external_url"):
                    return entry
                path = entry["page"]
                continue
            entry = by_page.get(path)
            if entry:
                return entry
            moved = builtin.redirect_for(v, path)
            if not moved:
                return None
            path = moved
        return None  # A redirect cycle is not a renderable target.
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

    links = 0
    limit = None
    visited: set[str] = set()
    queue = ["/"]
    while queue and remaining:
        path = queue.pop(0)
        if path in visited:
            continue
        if len(visited) == MAX_PAGES:
            limit = "pages"
            break
        visited.add(path)
        moved = moved_path(path)
        if moved:
            queue.append(moved)
            continue
        e = by_page.get(path)
        if e and e.get("external_url"):
            continue
        body = None
        if path == "/archive/" and v.site.get("archive", {}).get("enabled"):
            body = builtin.all_archive_page(v, {"sort": "date", "tag": "", "stream": ""}, origin, bool(t)).body.decode("utf-8")
        elif t:
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
        def prove_comment(comment: str) -> bool:
            if comment.startswith(marker) and comment[len(marker):].isdigit():
                i = int(comment[len(marker):])
                if i < len(v.entries):
                    remaining.discard(v.entries[i]["id"])
            return not remaining

        def prove_link(href: str) -> bool:
            try:
                url = _address(href, urljoin(origin, path))
                parts = urlsplit(url)
                if parts.scheme not in ("http", "https"):
                    return False
                remaining.difference_update(external.get(url, []))
                if (parts.scheme, parts.hostname, parts.port) == (base.scheme, base.hostname, base.port):
                    entry = target(parts.path or "/")
                    if entry:
                        remaining.discard(entry["id"])
                    queue.append(parts.path or "/")
            except ValueError:
                pass
            return not remaining

        parser = _Links(MAX_LINKS - links, prove_link, prove_comment)
        parser.feed(body)
        links += parser.links
        if parser.limited:
            limit = "links"
            break
    if limit:
        return [], {"limit": limit, "max_pages": MAX_PAGES, "max_links": MAX_LINKS, "pages": len(visited), "links": links}
    return [
        {"id": e["id"], "why": "no rendered link path from the home page to this entry"}
        for e in v.entries
        if e["id"] in remaining
    ], None
