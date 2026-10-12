"""Mustache themes (port of cloudflare/src/theme.ts, spec/TEMPLATES.md). A theme is a folder of logic-less templates; everything it
shows is decided here, display-ready: dates formatted, links resolved, flags
set. Rendering is mustache.js's (see mustache.py), escaping & < > " ' and
nothing else, as the Cloudflare edition does.
"""

import os
import re
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import Any

from . import mustache
from .blocks import contact_view, event_view, hours_view, notice_view
from .html import markdown
from .jsutil import S, long_date, short_date, string, trim, u16key, u16slice, url_host
from .site import SiteView
from .strings import STRINGS, strings_of

Data = dict[str, Any]

# The built-in looks: the repository's themes/ folder, or PORCHSITE_THEMES
# where the package is installed away from it (the container image).
THEMES = Path(os.environ.get("PORCHSITE_THEMES") or Path(__file__).resolve().parents[3] / "themes")


def host(u: str) -> str:
    h = url_host(u)
    return u if h is None else re.sub(r"^www\.", "", h)


def slug(t: str) -> str:
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", t.lower()))


def _or(*vals: Any) -> Any:
    """a || b || c"""
    for v in vals[:-1]:
        if v:
            return v
    return vals[-1]


def _q(v: Any, d: Any) -> Any:
    """v ?? d"""
    return d if v is None else v


def streams(site: Data) -> list[Data]:
    """The site's streams as a theme sees them."""
    every = site["streams"]
    out = []
    for i, s in enumerate(every):
        other = next((x for j, x in enumerate(every) if j != i), None)
        path = s["path"] or s["id"]
        handle = _q(site.get("handle"), "")
        out.append(
            {
                "id": s["id"],
                "anchor": s["anchor"] or s["id"],
                "title": s["title"],
                "byline": s["byline"],
                "intro": s["intro"],
                "author": s["author"],
                "nav_label": s["nav_label"] or s["title"],
                "archive_url": f"/{path}/",
                "feed_url": f"/{path}/feed.xml",
                "path": path,
                "all_label": s["all_label"] or f"{strings_of(site)['all_of']} {s['title']}",
                "link_label": s["link_label"],
                "description": string(_q(s.get("description"), "")).replace(
                    "{handle}", string(handle), 1
                ),
                "feed_subtitle": string(_q(s.get("feed_subtitle"), "")).replace(
                    "{handle}", string(handle), 1
                ),
                "see_also": {
                    "label": s["see_also_label"] or other["nav_label"] or other["title"],
                    "url": f"/{other['path'] or other['id']}/",
                }
                if other
                else None,
                "is_feature": s["layout"] == "feature",
                "is_list": s["layout"] != "feature",
            }
        )
    return out


Ctx = tuple[str, datetime, dict[str, str] | None]


def _ctx(v: SiteView) -> Ctx:
    return (
        string(v.site.get("timezone") or "UTC"),
        v.now or datetime.now(UTC),
        strings_of(v.site),
    )


def entry(e: Data, stream: Data, anchor: str = "", ctx: Ctx | None = None) -> Data:
    tz, now, words = ctx or ("UTC", datetime.now(UTC), None)
    tags = _q(e.get("tags"), [])
    stats = _q(e.get("stats"), [])
    return {
        **e,
        "event": event_view(e.get("event"), tz, now, words or STRINGS),
        "url": e.get("url"),
        "anchor": anchor,
        "date_short": short_date(e["date"]),
        "date_long": long_date(e["date"]),
        "has_body": bool(e.get("body")) and not e.get("external_url"),
        "body_html": markdown(e["body"]) if e.get("body") and not e.get("external_url") else "",
        "stats": stats,
        "has_stats": bool(len(stats)),
        "external": bool(e.get("external_url")),
        "cover_src": e.get("cover") or "",
        "cover_alt": e.get("cover_alt") or "",
        "tags": [{"name": name} for name in tags],
        "has_tags": len(tags) > 0,
        "label": (stream["link_label"] or "Read") if e.get("external_url") else "",
        "link": "",
        "link_host": "",
    }


def card(c: Data, aside: bool = False) -> Data:
    tags = _q(c.get("tags"), [])
    return {
        "name": c["name"],
        "description": c["description"],
        "status": _q(c.get("badge"), ""),
        "status_tone": _q(c.get("badge_tone"), "building"),
        "link": c.get("link"),
        "link_text": c.get("link_label") or (host(c["link"]) if c.get("link") else ""),
        "as_link": aside and bool(c.get("link")),
        "group": slug(_q(c.get("group"), "")),
        "group_label": _q(c.get("group"), ""),
        "subtitle": _q(c.get("subtitle"), ""),
        "period": _q(c.get("period"), ""),
        "price": _q(c.get("price"), ""),
        "tags": [{"name": name} for name in tags if name],
        "has_tags": any(bool(t) for t in tags),
        "image_src": _q(c.get("image"), ""),
        "image_alt": _q(c.get("image_alt"), ""),
        "has_image": bool(c.get("image")),
    }


def site_words(v: SiteView, release: str, origin: str) -> Data:
    s = v.site
    tz, now, words = _ctx(v)
    buttons = _q(s.get("buttons"), [])
    return {
        **s,
        "site_name": s["title"],
        "logo_text": s["logo_text"] or s["title"],
        "handle": s["handle"],
        "x_url": f"https://x.com/{s['handle']}" if s["handle"] else "",
        "follow_label": s["follow_label"] or "Follow on X",
        "description": s["description"] or s["tagline"] or u16slice(s["intro"], 0, 160),
        "hero_image": s["hero"],
        "contact": contact_view(s.get("contact")),
        "hours": hours_view(s.get("hours"), tz, now, words),
        "notice": notice_view(s.get("notice"), tz, now),
        "buttons": buttons,
        "has_buttons": len(buttons) > 0,
        "hero_width": v.hero_size[0] or 1200,
        "hero_height": v.hero_size[1] or 800,
        "contact_email": "",
        "updated": v.updated,
        "release": release,
        "base_url": origin,
    }


def base(v: SiteView, release: str, origin: str, meta: Data) -> Data:
    site = site_words(v, release, origin)
    st = streams(v.site)
    named = {
        "cards": v.site["cards_nav"] or v.site["cards_title"],
        "notes": v.site["notes_title"],
        "about": v.site["about_title"],
    }

    def anchor_of(k: str) -> str:
        return (v.site["cards_anchor"] or "cards") if k == "cards" else k

    order = v.site["sections"]
    sections = [
        x
        for k in order
        for x in ([y["id"] for y in st if y["id"] not in order] if k == "entries" else [k])
    ]

    # The menu names only sections with something in them: a stream with no
    # entries, no cards or an empty About would lead nowhere.
    def has_content(k: str) -> bool:
        if k == "cards":
            return len(v.cards) > 0
        if k == "about":
            return bool(trim(string(v.site.get("about") or "")))
        return any(e["stream"] == k for e in v.entries)

    nav = []
    for k in sections:
        if k == "notes" or not has_content(k):
            continue
        s = next((x for x in st if x["id"] == k), None)
        nav.append(
            {
                "href": f"/#{s['anchor'] if s else anchor_of(k)}",
                "label": s["nav_label"] if s else _q(named.get(k), k),
            }
        )
    image = meta.get("image")
    has_hero = bool(v.site["hero"])
    return {
        "site": site,
        "page": {
            "lede": v.site["intro"],
            "hero_alt": v.site["hero_alt"],
            "hero_caption": v.site["hero_caption"],
            "cta_label": v.site["cta_label"],
            "cta_link": v.site["cta_link"],
            "writing_cta_label": "",
        },
        "strings": strings_of(v.site),
        "nav": nav,
        "feeds": [{"title": x["nav_label"], "url": x["feed_url"]} for x in st],
        "kit": {
            "css_url": f"/static/site.css?v={release}",
            "beacon_url": f"/static/a.js?v={release}",
            "filter_url": f"/static/filter.js?v={release}",
            "search_url": f"/static/search.js?v={release}",
        },
        "meta": {
            "title": meta["title"],
            "description": _q(meta.get("description"), site["description"]),
            "og_type": _q(meta.get("og_type"), "website"),
            "url": f"{origin}{_q(meta.get('path'), '/')}",
            "image": f"{origin}{image}"
            if image
            else f"{origin}{v.site['share_image']}"
            if v.site["share_image"]
            else f"{origin}{v.site['hero']}"
            if has_hero
            else "",
            "image_alt": ""
            if image
            else v.site["share_image_alt"]
            if v.site["share_image"]
            else v.site["hero_alt"]
            if has_hero
            else "",
            "kind": meta["kind"],
            "content_id": _q(meta.get("content_id"), ""),
        },
    }


_PARAGRAPHS = re.compile(rf"\n{S}*\n")


def _group_style(site: Data, name: str) -> Data:
    """A card group's style (the site's card_groups) and a flag per style, for logic-less templates."""
    style = next(
        (string(x["style"]) for x in site.get("card_groups") or [] if x["name"] == name), ""
    )
    return {
        "style": style,
        "is_faq": style == "faq",
        "is_steps": style == "steps",
        "is_reviews": style == "reviews",
        "is_list": style == "list",
    }


def home_view(v: SiteView, release: str, origin: str) -> Data:
    st = streams(v.site)
    order = v.site["sections"]
    keys = [
        x
        for k in order
        for x in ([y["id"] for y in st if y["id"] not in order] if k == "entries" else [k])
    ]
    ctx = _ctx(v)
    out: list[Data] = []
    for k in keys:
        stream = next((x for x in st if x["id"] == k), None)
        sec: Data = {"is_entries": bool(stream), "is_cards": k == "cards", "is_about": k == "about"}
        if stream:
            items = [e for e in v.entries if e["stream"] == stream["id"]]
            sec["stream"] = stream
            sec["show"] = len(items) > 0
            sec["latest"] = [entry(items[0], stream, "", ctx)] if items else []
            sec["more_than_one"] = len(items) > 1
            sec["activity"] = [{**n, "date_short": short_date(n["date"])} for n in v.notes]
            sec["has_activity"] = stream["is_feature"] and len(v.notes) > 0
            sec["items"] = [
                entry(e, stream, "article" if i == 0 else "", ctx) for i, e in enumerate(items[:3])
            ]
            # Events: the next ones first, soonest first; past ones after, newest first.
            evs = [entry(e, stream, "", ctx) for e in items if e.get("event")]
            sec["upcoming"] = sorted(
                [e for e in evs if not e["event"]["is_past"]],
                key=lambda e: string(e["event"]["start"]),
            )
            sec["earlier"] = sorted(
                [e for e in evs if e["event"]["is_past"]],
                key=lambda e: string(e["event"]["start"]),
                reverse=True,
            )
            sec["has_upcoming"] = len(sec["upcoming"]) > 0
            sec["has_earlier"] = len(sec["earlier"]) > 0
            # Entries that aren't events, in a stream that has some: newest first.
            sec["others"] = (
                [entry(e, stream, "", ctx) for e in items if not e.get("event")] if evs else []
            )
            sec["has_others"] = len(sec["others"]) > 0
            sec["all"] = [entry(e, stream, "", ctx) for e in items]
            sec["count_suffix"] = f" ({len(items)})" if len(items) > 3 else ""
        elif k == "cards":
            groups = list(dict.fromkeys(c.get("group") for c in v.cards if c.get("group")))
            # The aside group goes last, under its own heading, each card a link.
            aside_name = string(v.site.get("cards_aside") or "")
            main = [c for c in v.cards if not aside_name or c.get("group") != aside_name]
            aside = [c for c in v.cards if c.get("group") == aside_name] if aside_name else []
            gorder = [g for g in groups if g != aside_name] + [g for g in groups if g == aside_name]
            if gorder:
                by_group_keys = ([""] if any(not c.get("group") for c in main) else []) + [
                    g for g in gorder if g != aside_name
                ]
                by_group = [
                    {
                        "label": g,
                        "key": slug(g),
                        "cards": [card(c) for c in main if _q(c.get("group"), "") == g],
                        **_group_style(v.site, g),
                    }
                    for g in by_group_keys
                ]
            else:
                by_group = [
                    {
                        "label": "",
                        "key": "",
                        "cards": [card(c) for c in main],
                        **_group_style(v.site, ""),
                    }
                ]
            sec.update(
                {
                    "anchor": v.site["cards_anchor"] or "cards",
                    "title": v.site["cards_title"],
                    "show": len(v.cards) > 0,
                    "groups": [
                        {
                            "key": slug(g),
                            "label": g,
                            "count": len([c for c in v.cards if c.get("group") == g]),
                        }
                        for g in gorder
                    ],
                    "has_chips": len(groups) > 1,
                    "projects": [card(c) for c in main],
                    "has_projects": len(main) > 0,
                    "open_source": [card(c, True) for c in aside],
                    "has_open_source": len(aside) > 0,
                    "open_source_label": aside_name,
                    "by_group": by_group,
                }
            )
        elif k == "about":
            sec.update(
                {
                    "anchor": "about",
                    "title": v.site["about_title"],
                    "paragraphs": [
                        p
                        for p in (trim(p) for p in _PARAGRAPHS.split(string(v.site["about"])))
                        if p
                    ],
                }
            )
        out.append(sec)
    for i, sec in enumerate(out):
        sec["not_last"] = i < len(out) - 1
    s = v.site
    return {
        **base(
            v,
            release,
            origin,
            {
                "kind": "home",
                "title": f"{s['title']}: {s['tagline']}" if s["tagline"] else s["title"],
            },
        ),
        # The theme's hero buttons show with a button to show.
        "has_writing": bool(s["cta_label"]),
        "hero_more": {"href": s["cta2_link"] or "/", "label": s["cta2_label"]}
        if s["cta2_label"]
        else None,
        "sections": out,
    }


def entry_view(v: SiteView, e: Data, release: str, origin: str) -> Data:
    stream = next(x for x in streams(v.site) if x["id"] == e["stream"])
    s = v.site

    def here(link: str) -> bool:
        return link == e.get("page") or link == e.get("url")

    if s["cta_label"] and s["cta_link"] and not here(s["cta_link"]):
        nxt = {"href": s["cta_link"], "label": s["cta_label"]}
    elif s["cta2_label"] and s["cta2_link"] and not here(s["cta2_link"]):
        nxt = {"href": s["cta2_link"], "label": s["cta2_label"]}
    else:
        nxt = None
    meta = {
        "kind": "entry",
        "content_id": e["id"],
        "title": f"{e['title']} · {s['title']}",
        "description": e.get("summary") or e["title"],
        "path": e["url"],
        "og_type": "article",
        "image": v.share_cards.get(e["id"]) or e.get("cover") or None,
    }
    return {
        **base(v, release, origin, meta),
        "entry": entry(e, stream, "", _ctx(v)),
        "stream": stream,
        "next": nxt,
    }


def archive_view(
    v: SiteView, stream_path: str, release: str, origin: str, tag: str | None = None
) -> Data | None:
    stream = next((x for x in streams(v.site) if x["path"] == stream_path), None)
    if not stream:
        return None
    items = [e for e in v.entries if e["stream"] == stream["id"]]
    counts: dict[str, int] = {}
    for e in items:
        for t in _q(e.get("tags"), []):
            counts[t] = counts.get(t, 0) + 1
    if tag:
        items = [e for e in items if tag in _q(e.get("tags"), [])]
    path = f"{stream['archive_url']}tags/{tag}/" if tag else stream["archive_url"]
    title = f"{f'#{tag} · ' if tag else ''}{stream['nav_label']} · {v.site['title']}"
    meta = {
        "kind": "tag" if tag else "archive",
        "title": title,
        "path": path,
        "description": stream["description"] or None,
        # Shared, the page shows its newest entry's cover, as an entry's page shows its own.
        "image": next((e["cover"] for e in items if e.get("cover")), None),
    }
    ctx = _ctx(v)
    # [...counts].sort(): each [name, count] pair compared as the string "name,count".
    pairs = sorted(counts.items(), key=lambda p: u16key(f"{p[0]},{p[1]}"))
    return {
        **base(v, release, origin, meta),
        "stream": stream,
        "tag": tag or "",
        "entries": [entry(e, stream, "", ctx) for e in items],
        "tags": [{"name": n, "count": c} for n, c in pairs],
        "has_tags": len(counts) > 0,
    }


def not_found_view(v: SiteView, release: str, origin: str) -> Data:
    return base(
        v,
        release,
        origin,
        {
            "kind": "notfound",
            "title": f"{strings_of(v.site)['not_found_title']} · {v.site['title']}",
        },
    )


# --- rendering -----------------------------------------------------------------------

_ESC = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;"}


def escape(v: str) -> str:
    return re.sub(r"[&<>\"']", lambda m: _ESC[m.group(0)], v)


def _read(p: Path) -> str:
    return p.read_bytes().decode("utf-8")


@cache
def _theme(root: Path, name: str) -> tuple[mustache.Writer, dict[str, str], dict[str, str]]:
    d = root / name
    partials = {
        p.name[: -len(".mustache")]: _read(p) for p in sorted((d / "partials").glob("*.mustache"))
    }
    pages = {p.name[: -len(".mustache")]: _read(p) for p in sorted(d.glob("*.mustache"))}
    return mustache.Writer(escape), pages, partials


def render(name: str, page: str, view: Data, root: Path = THEMES) -> str:
    writer, pages, partials = _theme(Path(root), name)
    return writer.render(pages[page], view, partials)
