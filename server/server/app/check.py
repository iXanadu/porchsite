"""site_check: the site as it will be once everything staged is published,
looked over the way a visitor would click through it (SPEC §4). Links
inside the site that lead nowhere (a page, a section, a picture) and
sections in the layout with nothing in them. Port of cloudflare/src/check.ts.
"""

import re
from typing import Any

from server.spec.jsutil import string, trim
from server.spec.site import SiteView
from server.spec.theme import streams

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
    return {"ok": not broken and not empty, "broken": broken, "empty_sections": empty}
