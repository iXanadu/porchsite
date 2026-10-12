"""The owner's yes (SPEC S1, S2). An assistant asks for named items at their
current versions; only the owner's decision publishes, and only exactly what
was shown. Port of cloudflare/src/approvals.ts.

An approval is a dict: id, items (each: id, version, kind, label, change,
status, note), note, requested_by, status (pending | decided),
decision_note, created_at, decided_at.
"""

import base64
import json
import secrets
from typing import Any

from server.spec.jsutil import u16slice

from .content import all_items, get_item, staged
from .db import Db, dumps, now, transaction
from .errors import ApiError
from .visibility import check_public

Approval = dict[str, Any]
DECISIONS = ("approve", "changes", "deny", "later")


def _to_approval(r: Any) -> Approval:
    return {
        "id": r["id"],
        "items": json.loads(r["items"]),
        "note": r["note"],
        "requested_by": r["requested_by"],
        "status": r["status"],
        "decision_note": r["decision_note"],
        "created_at": r["created_at"],
        "decided_at": r["decided_at"],
    }


def label(item: dict[str, Any]) -> str:
    d = item["data"]
    for k in ("title", "name", "text"):
        if d.get(k) is not None:
            return d[k]
    return item["kind"]


def _new_id() -> str:
    return base64.b64encode(secrets.token_bytes(12)).decode().replace("+", "-").replace("/", "_")


async def _update(c: Any, a: Approval) -> None:
    done = all(i["status"] != "pending" for i in a["items"])
    await c.execute(
        "UPDATE approvals SET items = $1, status = $2, decision_note = $3, decided_at = $4 WHERE id = $5",
        dumps(a["items"]),
        "decided" if done else "pending",
        a["decision_note"],
        (a["decided_at"] or now()) if done else None,
        a["id"],
    )


async def request(db: Db, actor: str, ids: list[str], note: str) -> Approval:
    if not ids:
        raise ApiError(422, "invalid", "Name at least one item.")
    pending = {i["id"]: i for i in await staged(db)}
    items: list[dict[str, Any]] = []
    for id in dict.fromkeys(ids):
        item = pending.get(id) or await get_item(db, id)
        if id not in pending:
            raise ApiError(
                409, "nothing_to_approve", f"Item {id} is the same as what's live. Change it first."
            )
        if (
            item["kind"] == "entry"
            and item["data"].get("status") == "draft"
            and not item["deleted"]
        ):
            raise ApiError(409, "draft", f'Entry {id} is a draft. Set status to "ready" first.')
        live = pending[id]["live_version"]
        items.append(
            {
                "id": id,
                "version": item["version"],
                "kind": item["kind"],
                "label": label(item),
                "change": "removed" if item["deleted"] else "new" if live is None else "changed",
                "status": "pending",
                "note": "",
            }
        )
    approval: Approval = {
        "id": _new_id(),
        "items": items,
        "note": u16slice(note, 0, 1000),
        "requested_by": actor,
        "status": "pending",
        "decision_note": "",
        "created_at": now(),
        "decided_at": None,
    }
    async with transaction(db) as c:
        # A newer request for an item replaces the item in any older open request.
        for a in await _list_raw(c, "pending"):
            touched = False
            for it in a["items"]:
                if it["status"] == "pending" and it["id"] in ids:
                    it["status"] = "superseded"
                    touched = True
            if touched:
                await _update(c, a)
        await c.execute(
            "INSERT INTO approvals (id, items, note, requested_by, status, created_at)"
            " VALUES ($1, $2, $3, $4, 'pending', $5)",
            approval["id"],
            dumps(items),
            approval["note"],
            actor,
            approval["created_at"],
        )
    return approval


async def _list_raw(db: Db, status: str | None = None) -> list[Approval]:
    if status:
        rows = await db.fetch(
            "SELECT * FROM approvals WHERE status = $1 ORDER BY created_at DESC LIMIT 100", status
        )
    else:
        rows = await db.fetch("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100")
    return [_to_approval(r) for r in rows]


async def get(db: Db, id: str) -> Approval:
    """An approval with each pending item checked against the item's current version."""
    row = await db.fetchrow("SELECT * FROM approvals WHERE id = $1", id)
    if not row:
        raise ApiError(404, "not_found", f"No approval {id}.")
    return await _freshen(db, _to_approval(row))


async def _freshen(db: Db, a: Approval) -> Approval:
    for it in a["items"]:
        if it["status"] != "pending":
            continue
        cur = await db.fetchval("SELECT version FROM items WHERE id = $1", it["id"])
        if cur is None or cur != it["version"]:
            it["status"] = "superseded"
    if all(i["status"] != "pending" for i in a["items"]):
        a["status"] = "decided"
    return a


async def list(db: Db, status: str | None = None) -> list[Approval]:  # noqa: A001 (approvals.list, as in TS)
    return [await _freshen(db, a) for a in await _list_raw(db, status)]


async def decide(
    db: Db,
    id: str,
    decisions: dict[str, dict[str, Any]],
    overall: str,
) -> dict[str, Any]:
    """Apply the owner's decisions. Approved items go live together, at the
    exact version the owner saw; an item edited since is refused, not published.
    Returns {approval, published}."""
    a = await get(db, id)
    published: list[str] = []
    at = now()
    async with transaction(db) as c:
        for it in a["items"]:
            d = decisions.get(it["id"])
            if not d or d.get("decision") == "later" or it["status"] != "pending":
                continue
            it["note"] = u16slice(d.get("note") or "", 0, 2000)
            if d.get("decision") == "deny":
                it["status"] = "denied"
            elif d.get("decision") == "changes":
                it["status"] = "changes_requested"
            else:
                # Locked until this decision is written, so an edit can't slip in between.
                row = await c.fetchrow("SELECT * FROM items WHERE id = $1 FOR UPDATE", it["id"])
                if not row:
                    raise ApiError(404, "not_found", f"No item {it['id']}.")
                if row["version"] != it["version"]:
                    it["status"] = "superseded"
                    continue
                await _go_live(c, row, at)
                it["status"] = "published"
                published.append(row["id"])
        # Nothing public may name a private card: refused before anything changes.
        if published:
            await check_public(c, await live_rows(c))
        a["decision_note"] = u16slice(overall, 0, 2000) or a["decision_note"]
        if all(i["status"] != "pending" for i in a["items"]):
            a["decided_at"] = at
        await _update(c, a)
        if published:
            await c.execute(
                "INSERT INTO publishes (actor, approval_id, items, created_at) VALUES ('owner', $1, $2, $3)",
                a["id"],
                dumps(
                    [
                        {"id": i["id"], "version": i["version"]}
                        for i in a["items"]
                        if i["id"] in published
                    ]
                ),
                at,
            )
    return {"approval": await get(db, id), "published": published}


async def _go_live(c: Any, row: Any, at: str) -> None:
    if row["deleted"]:
        await c.execute("DELETE FROM live WHERE item_id = $1", row["id"])
    else:
        await c.execute(
            "INSERT INTO live (item_id, kind, slug, version, data, published_at)"
            " VALUES ($1, $2, $3, $4, $5, $6)"
            " ON CONFLICT (item_id) DO UPDATE SET slug = excluded.slug,"
            " version = excluded.version, data = excluded.data,"
            " published_at = excluded.published_at",
            row["id"],
            row["kind"],
            row["slug"],
            row["version"],
            row["data"],
            at,
        )


async def live_rows(db: Db) -> "list[dict[str, Any]]":
    """What's live, as rows {id, kind, data}."""
    return [
        {"id": r["item_id"], "kind": r["kind"], "data": json.loads(r["data"])}
        for r in await db.fetch('SELECT item_id, kind, data FROM live ORDER BY item_id COLLATE "C"')
    ]


async def publish_now(db: Db, items: "list[dict[str, Any]]", note: str) -> "list[str]":
    """The owner publishes exactly these items ({id, version}), at exactly
    these versions, with no approval request (the owner is the approver): the
    writing desk and the whole-site revert. An item changed since is refused
    (item_changed). A pending request for the same version is marked published."""
    if not items:
        return []
    at = now()
    async with transaction(db) as c:
        going = []
        for want in items:
            row = await c.fetchrow("SELECT * FROM items WHERE id = $1 FOR UPDATE", want["id"])
            if not row:
                raise ApiError(404, "not_found", f"No item {want['id']}.")
            if row["version"] != want["version"]:
                raise ApiError(
                    409,
                    "item_changed",
                    f"{row['id']} changed since (version {want['version']} → {row['version']}). Reload and try again.",
                    {"id": row["id"], "current_version": row["version"]},
                )
            going.append(row)
        for row in going:
            await _go_live(c, row, at)
        await check_public(c, await live_rows(c))
        for a in await _list_raw(c, "pending"):
            touched = False
            for it in a["items"]:
                if it["status"] == "pending" and any(
                    g["id"] == it["id"] and g["version"] == it["version"] for g in going
                ):
                    it["status"] = "published"
                    touched = True
            if touched:
                await _update(c, a)
        await c.execute(
            "INSERT INTO publishes (actor, approval_id, items, created_at, note) VALUES ('owner', NULL, $1, $2, $3)",
            dumps([{"id": g["id"], "version": g["version"]} for g in going]),
            at,
            u16slice(note, 0, 1000),
        )
    return [g["id"] for g in going]


async def unsent(db: Db) -> int:
    """How many items have a change no open request covers: the current
    version isn't live and isn't waiting for the owner. Unfinished entry
    drafts don't count. /review says so, so a change nobody sent isn't
    invisible."""
    live = {r["item_id"]: r["version"] for r in await db.fetch("SELECT item_id, version FROM live")}
    asked = {
        (i["id"], i["version"])
        for a in await list(db, "pending")
        for i in a["items"]
        if i["status"] == "pending"
    }
    n = 0
    for i in await all_items(db):
        lv = live.get(i["id"])
        if (lv is None) if i["deleted"] else (lv == i["version"]):
            continue
        if not i["deleted"] and i["kind"] == "entry" and i["data"].get("status") == "draft":
            continue
        if (i["id"], i["version"]) not in asked:
            n += 1
    return n
