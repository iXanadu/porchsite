"""The owner's writing desk (SPEC §5, /review/write): the owner writes and
edits entries, and publishes one directly. The owner is the approver, so the
owner's own publish needs no approval request: it makes exactly that entry,
at the version on screen, live. Every write goes through content.py as the
actor "owner", so versions, revisions and the guard all apply. Drafts the
assistant made show up here for the owner to finish. Port of
cloudflare/src/desk.ts.
"""

import re
from typing import Any

from server.spec.jsutil import S, trim

from . import content
from .approvals import publish_now
from .db import Db
from .errors import ApiError

# What the form edits; everything else on the entry is left alone.
FIELDS = ("stream", "title", "summary", "date", "tags", "cover", "cover_alt", "body")


def _state(item: dict[str, Any], live: int | None) -> str:
    if live is None:
        return "draft" if item["data"].get("status") == "draft" else "ready, not live"
    return "live" if live == item["version"] else "live, edited since"


async def entries(db: Db) -> list[dict[str, Any]]:
    """Every entry not removed, newest first, with where it stands."""
    rows = await db.fetch(
        "SELECT i.*, l.version AS live_version FROM items i LEFT JOIN live l ON l.item_id = i.id"
        " WHERE i.kind = 'entry' AND NOT i.deleted"
    )
    out = []
    for r in rows:
        item = content.to_item(r)
        out.append(
            {**item, "live_version": r["live_version"], "state": _state(item, r["live_version"])}
        )
    out.sort(key=lambda e: e["created_at"], reverse=True)
    out.sort(key=lambda e: str(e["data"].get("date")), reverse=True)
    return out


async def get(db: Db, id: str) -> dict[str, Any]:
    try:
        item = await content.get_item(db, id)
    except ApiError:
        item = None
    if not item or item["kind"] != "entry" or item["deleted"]:
        raise ApiError(404, "not_found", "There is no entry at this address.")
    live = await db.fetchval("SELECT version FROM live WHERE item_id = $1", id)
    return {**item, "live_version": live, "state": _state(item, live)}


def clean(form: dict[str, str], current: dict[str, Any] | None) -> dict[str, Any]:
    """Form strings to entry fields. An unchanged cover is left out, so it isn't fetched again."""

    def v(k: str) -> str:
        return trim(str(form.get(k) or ""))

    data: dict[str, Any] = {
        "stream": v("stream"),
        "title": v("title"),
        "summary": v("summary"),
        "date": v("date"),
        "tags": [t for t in re.split(f"{S}+", v("tags").replace(",", " ")) if t],
        "cover": v("cover"),
        "cover_alt": v("cover_alt"),
        "body": trim(str(form.get("body") or "").replace("\r\n", "\n")),
    }
    if current is not None and data["cover"] == str(current.get("cover") or ""):
        del data["cover"]
    return data


async def save(db: Db, id: str | None, version: int | None, form: dict[str, str]) -> dict[str, Any]:
    """Create (as a draft) or update an entry as the owner."""
    if id is None:
        return await content.create_item(
            db, "owner", "entry", {**clean(form, None), "status": "draft"}, None
        )
    current = await get(db, id)
    return await content.update_item(
        db,
        "owner",
        id,
        -1 if version is None else version,
        clean(form, current["data"]),
        "owner edited",
    )


async def publish(db: Db, id: str, version: int) -> dict[str, Any]:
    """Mark the entry ready and make exactly it live."""
    item = await get(db, id)
    if item["data"].get("status") != "ready":
        item = await content.update_item(
            db, "owner", id, version, {"status": "ready"}, "owner published"
        )
    elif item["version"] != version:
        raise ApiError(
            409,
            "version_conflict",
            f"Item {id} is at version {item['version']}, not {version}. Re-read it and redo your change.",
            {"current_version": item["version"]},
        )
    await publish_now(
        db, [{"id": id, "version": item["version"]}], "published by the owner from the writing desk"
    )
    return item
