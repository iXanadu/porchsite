"""The public site's view, from `live` only: nothing a visitor sees has
skipped the owner's approval. Port of the database half of
cloudflare/src/site.ts (liveView, proposedView); the pure half, view(), is
server/spec/site.py. Also the two pages the services can make whole without
HTTP: the live home page and the owner's preview, in the site's theme.
"""

import json
import re
from datetime import datetime
from typing import Any

from server.spec import theme as views
from server.spec.jsutil import MONTHS, local, zone_short_name
from server.spec.models import SITE_ID
from server.spec.site import SiteView, view

from . import approvals, themes
from .content import validate
from .db import Db, now
from .media import LOCAL, size_of
from .theme import render, static_file

Data = dict[str, Any]


async def live_view(db: Db) -> SiteView:
    return await proposed_view(db, [])


def _updated(last: str, timezone: str) -> str:
    """When the site last changed, on the site's clock."""
    d = datetime.fromisoformat(last.replace("Z", "+00:00"))
    t = local(d, timezone)
    time = f"{t.hour % 12 or 12}:{t.minute:02d} {'AM' if t.hour < 12 else 'PM'}"
    day = f"{MONTHS[t.month - 1][:3]} {t.day}"
    # "EDT" / "EST" read better as "ET" (likewise CT, MT, PT).
    zone = re.sub(r"^([ECMP])[SD]T\Z", r"\1T", zone_short_name(timezone, d))
    return f"{day}, {time} {zone}"


async def proposed_view(
    db: Db, changes: list[dict[str, Any]], ready: str | None = None
) -> SiteView:
    """The site as it would be with these item versions ({id, version})
    published on top of what's live (an approval's items); [] is the live site.
    `ready` names an entry to show even if it is a draft (the writing desk's
    preview)."""
    rows: dict[str, Data] = {
        r["item_id"]: {
            "id": r["item_id"],
            "kind": r["kind"],
            "slug": r["slug"],
            "data": json.loads(r["data"]),
            "published_at": r["published_at"],
            "created": r["created_at"] or "",
            "version": r["version"],
        }
        for r in await db.fetch(
            "SELECT l.*, i.created_at FROM live l LEFT JOIN items i ON i.id = l.item_id"
            ' ORDER BY l.item_id COLLATE "C"'
        )
    }
    at = now()
    for c in changes:
        rev = await db.fetchrow(
            "SELECT r.data, r.deleted, i.kind, i.slug, i.created_at FROM revisions r JOIN items i ON i.id = r.item_id"
            " WHERE r.item_id = $1 AND r.version = $2",
            c["id"],
            c["version"],
        )
        if not rev:
            continue
        if rev["deleted"]:
            rows.pop(c["id"], None)
        else:
            rows[c["id"]] = {
                "id": c["id"],
                "kind": rev["kind"],
                "slug": rev["slug"],
                "data": json.loads(rev["data"]),
                "published_at": at,
                "created": rev["created_at"],
                "version": c["version"],
            }
    # The writing desk's preview shows a draft as it will look once published.
    shown = rows.get(ready) if ready else None
    if shown:
        shown["data"] = {**shown["data"], "status": "ready"}
    site_row = rows.get(SITE_ID)
    site = validate("site", site_row["data"] if site_row else {})
    v = view(site, [r for r in rows.values() if r["kind"] != "site"])
    v.share_cards = {
        c["item_id"]: f"/media/{c['name']}"
        for c in await db.fetch("SELECT item_id, version, name FROM share_cards")
        if c["item_id"] in rows and rows[c["item_id"]].get("version") == c["version"]
    }
    hero = LOCAL.search(str(site.get("hero")))
    if hero:
        v.hero_size = await size_of(db, hero.group(1))
    last = max((r["published_at"] for r in rows.values()), default="")
    if last:
        v.updated = _updated(last, str(site.get("timezone") or "UTC"))
    return v


def release_of(v: SiteView) -> str:
    """The cache-busting release the live pages carry: when the site last changed."""
    return re.sub(r"[^0-9A-Za-z]", "", v.updated) or "0"


async def home_page(db: Db, origin: str) -> str | None:
    """The live home page in the site's theme; None when the site has no theme
    of that name (the Cloudflare edition then shows its built-in look)."""
    v = await live_view(db)
    t = await themes.load(db, str(v.site["theme"]))
    if not t:
        return None
    return render(t, "home", views.home_view(v, release_of(v), origin))


async def preview_page(db: Db, approval_id: str, origin: str, path: str = "/") -> str | None:
    """The home page with this approval's items published on top of what's
    live, in the theme it would have, its stylesheet and palette inline (a
    page's /static/ serves the LIVE theme, which before a first approval or a
    theme switch isn't this one). The routes add the preview bar. None when the
    proposed site has no theme of that name."""
    a = await approvals.get(db, approval_id)
    v = await proposed_view(
        db,
        [
            {"id": i["id"], "version": i["version"]}
            for i in a["items"]
            if i["status"] in ("pending", "published")
        ],
    )
    t = await themes.load(db, str(v.site["theme"]))
    if not t:
        return None
    if path == "/":
        return inline_css(t, v, render(t, "home", views.home_view(v, "preview", origin)))
    e = next((x for x in v.entries if x.get("page") == path and not x.get("external_url")), None)
    if e:
        return inline_css(t, v, render(t, "entry", views.entry_view(v, e, "preview", origin)))
    arch = re.match(r"^/([a-z][a-z0-9-]{0,29})/(?:tags/([a-z0-9-]{1,30})/)?\Z", path)
    av = views.archive_view(v, arch.group(1), "preview", origin, arch.group(2)) if arch else None
    if av:
        return inline_css(t, v, render(t, "tag" if arch.group(2) else "archive", av))
    return ""


def inline_css(t: Any, v: SiteView, body: str) -> str:
    """The proposed theme's stylesheet and palette go inline: /static/ serves
    the LIVE theme, which before a first approval (or a theme switch) isn't
    this one."""
    if not t:
        return body
    css = static_file(t, "site.css", str(v.site.get("palette") or ""))
    if css:
        inline = "<style>" + re.sub(r"</style", r"<\\/style", css["body"], flags=re.I) + "</style>"
        body = re.sub(
            r'<link rel="stylesheet" href="/static/site\.css[^"]*">',
            lambda _m: inline,
            body,
            count=1,
        )
    return body
