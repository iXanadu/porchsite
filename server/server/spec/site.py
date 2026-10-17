"""The site's view (port of the pure part of cloudflare/src/site.ts: view())."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .jsutil import collate_key

Data = dict[str, Any]


@dataclass
class SiteView:
    site: Data
    entries: list[Data]
    cards: list[Data]
    notes: list[Data]
    # When the site last changed, for themes that say so.
    updated: str = ""
    # The hero image's pixel size, when known.
    hero_size: tuple[int, int] = (0, 0)
    # Each entry's share card, /media/<name>, when it matches the entry's version.
    share_cards: dict[str, str] = field(default_factory=dict)
    # When the page is being made; None: now.
    now: datetime | None = field(default=None)
    # View-only approval timestamps for discovery; never persisted in item data.
    approved_at: dict[str, str] = field(default_factory=dict)


_MENTION = {"link": "", "link_label": "", "image": "", "image_alt": ""}


def view(site: Data, rows: list[Data]) -> SiteView:
    """Build the view from rows shaped like `live`: {id, kind, slug, data}."""
    streams = [x["id"] for x in site["streams"]]
    path_of = {x["id"]: x["path"] or x["id"] for x in site["streams"]}
    # Newest created first, so the date sorts below leave same-day items that way.
    rows = sorted(rows, key=lambda r: str(r.get("created") or ""), reverse=True)
    entries = []
    for r in rows:
        if r["kind"] != "entry" or r["data"].get("status") == "draft":
            continue
        # An unknown or empty stream reads as the first, so no entry goes missing.
        stream = r["data"].get("stream") if r["data"].get("stream") in streams else streams[0]
        page = f"/{path_of[stream]}/{r['slug']}/"
        entries.append(
            {
                **r["data"],
                "id": r["id"],
                "slug": r["slug"],
                "stream": stream,
                "page": page,
                "url": r["data"].get("external_url") or page,
            }
        )
    entries.sort(key=lambda e: str(e["date"]), reverse=True)
    # A private card is never shown; a mention shows its name and description only.
    cards = [
        {
            **({
                **{k:r["data"][k] for k in ("name", "description", "sort", "visibility")},
                **_MENTION,
            } if r["data"].get("visibility") == "mention" else r["data"]),
            "id": r["id"],
        }
        for r in rows
        if r["kind"] == "card" and r["data"].get("visibility") != "private"
    ]
    cards.sort(key=lambda c: (c["sort"], collate_key(str(c["name"]))))
    notes = [{**r["data"], "id": r["id"]} for r in rows if r["kind"] == "note"]
    notes.sort(key=lambda n: str(n["date"]), reverse=True)
    return SiteView(site=site, entries=entries, cards=cards, notes=notes[:12])
