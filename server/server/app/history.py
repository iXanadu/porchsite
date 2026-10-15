"""The site's past publishes, and putting the whole site back to one of them
(SPEC S5, §5 /review/history). A revert is the owner's own act: every item
that differs from how it was at that publish gets a new version with its
content from then (or is taken off), and those versions go live together as
a new publish, recorded with the owner's note. Nothing is deleted: the
revert is itself in the history and can be reverted. Port of
cloudflare/src/history.ts.
"""

import json
from typing import Any

from server.spec.models import SITE_ID

from . import content
from .approvals import live_rows, publish_now
from .db import Db, dumps, transaction
from .embed_storage import source_data
from .errors import ApiError
from .visibility import RANK, check_public

Data = dict[str, Any]


def label_of(kind: str, data: Data) -> str:
    if kind == "site":
        return "Your site's text and look"
    return next((data[k] for k in ("title", "name", "text") if data.get(k) is not None), kind)


async def _revision(db: Db, id: str, version: int) -> Any:
    row = await db.fetchrow(
        "SELECT r.data, r.deleted, i.kind FROM revisions r JOIN items i ON i.id = r.item_id"
        " WHERE r.item_id = $1 AND r.version = $2",
        id,
        version,
    )
    return {**dict(row), "data": dumps(await source_data(db, id, version, json.loads(row["data"])))} if row else None


async def _to_publish(db: Db, r: Any) -> dict[str, Any]:
    items = []
    for it in json.loads(r["items"]):
        rev = await _revision(db, it["id"], it["version"])
        kind = rev["kind"] if rev else ""
        items.append(
            {
                "id": it["id"],
                "version": it["version"],
                "kind": kind,
                "label": label_of(kind, json.loads(rev["data"])) if rev else it["id"],
                "removed": bool(rev["deleted"]) if rev else False,
            }
        )
    requested_by = ""
    if r["approval_id"]:
        requested_by = (
            await db.fetchval("SELECT requested_by FROM approvals WHERE id = $1", r["approval_id"])
            or ""
        )
    return {
        "id": r["id"],
        "actor": r["actor"],
        "approval_id": r["approval_id"],
        "requested_by": requested_by,
        "note": r["note"] or "",
        "created_at": r["created_at"],
        "items": items,
    }


async def publishes(db: Db, limit: int = 50) -> list[dict[str, Any]]:
    """The newest publishes first."""
    rows = await db.fetch("SELECT * FROM publishes ORDER BY id DESC LIMIT $1", limit)
    return [await _to_publish(db, r) for r in rows]


async def get_publish(db: Db, id: int) -> dict[str, Any]:
    row = await db.fetchrow("SELECT * FROM publishes WHERE id = $1", id)
    if not row:
        raise ApiError(404, "not_found", f"No publish {id}.")
    return await _to_publish(db, row)


async def _state_at(db: Db, id: int) -> dict[str, int]:
    """Which version of each item was live just after this publish."""
    state: dict[str, int] = {}
    for r in await db.fetch("SELECT items FROM publishes WHERE id <= $1 ORDER BY id", id):
        for it in json.loads(r["items"]):
            state[it["id"]] = it["version"]
    return state


async def plan(db: Db, id: int) -> dict[str, Any]:
    """What putting the site back to this publish changes: {publish, changes}.
    A card that's live now never comes back more visible than it is now
    (private → mention → public stays an explicit change)."""
    publish = await get_publish(db, id)
    state = await _state_at(db, id)
    live = {
        r["item_id"]: {"version": r["version"], "data": await source_data(db, r["item_id"], r["version"], json.loads(r["data"]), True)}
        for r in await db.fetch("SELECT item_id, version, data FROM live")
    }
    changes = []
    for item_id in sorted(set(state) | set(live)):
        lv = live.get(item_id)
        want = state.get(item_id)
        rev = await _revision(db, item_id, want) if want is not None else None
        if rev and rev["deleted"]:
            want = None
        if want is None and not lv:
            continue
        if lv and want == lv["version"]:
            continue
        # The site's text is never taken off or reset to placeholder words: a
        # publish from before it was first published leaves it as it is.
        if want is None and item_id == SITE_ID:
            continue
        item = await content.get_item(db, item_id)
        deleted = False
        if want is None:
            data = item["data"]
            deleted = True
        else:
            data = json.loads(rev["data"])
            if item["kind"] == "card" and lv:
                then = data.get("visibility")
                then = "public" if then is None else str(then)
                now_vis = lv["data"].get("visibility")
                now_vis = "public" if now_vis is None else str(now_vis)
                if RANK.get(then, 2) > RANK.get(now_vis, 2):
                    data = {**data, "visibility": now_vis}
        if not deleted and lv and dumps(data) == dumps(lv["data"]):
            continue
        changes.append(
            {
                "id": item_id,
                "kind": item["kind"],
                "label": label_of(item["kind"], item["data"] if deleted else data),
                "action": "take off" if deleted else "put back",
                "data": data,
                "deleted": deleted,
                # What is live now (None when the item isn't on the site).
                "live": lv["data"] if lv else None,
            }
        )
    return {"publish": publish, "changes": changes}


async def revert(db: Db, id: int, note: str, origin: str = "") -> dict[str, Any]:
    """Put the site back to this publish, as a new publish by the owner."""
    async with transaction(db) as c:
        p = await plan(c, id)
        changes = p["changes"]
        if not changes:
            raise ApiError(409, "nothing_to_revert", "The site already matches that publish.")
        # Checked before anything is written, so a refusal leaves no stray versions.
        rows = {r["id"]: r for r in await live_rows(c)}
        for ch in changes:
            if ch["deleted"]:
                rows.pop(ch["id"], None)
            else:
                rows[ch["id"]] = {"id": ch["id"], "kind": ch["kind"], "data": ch["data"]}
        await check_public(c, list(rows.values()))
        when = p["publish"]["created_at"][:16].replace("T", " ", 1)
        reason = f"back to the site as published {when} UTC"
        going = []
        for ch in changes:
            item = await content.get_item(c, ch["id"])
            done = await content.restore(
                c, "owner", ch["id"], item["version"], ch["data"], ch["deleted"], reason
            )
            going.append({"id": done["id"], "version": done["version"]})
        words = f"Put the site back to publish {id}" + (f": {note.strip()}" if note.strip() else "")
        return {"published": await publish_now(c, going, words, origin)}
