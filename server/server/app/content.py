"""Every content write goes through here, so the safety rules always apply:
versions (S3), idempotency (S4), revisions (S5) and the guard (S6). Port of
cloudflare/src/content.ts.

An item is a plain dict shaped as the Cloudflare edition's JSON: id, kind,
slug, version, data, deleted, created_at, updated_at (and replayed: True when
an idempotency key returned an item created earlier).
"""

import hashlib
import json
import re
import secrets
import unicodedata
from typing import Any

import asyncpg
from pydantic import ValidationError

from server.spec.embed_url import embed_sources
from server.spec.models import KINDS, MODELS, PREFIX, SITE_ID

from . import media
from .db import Db, dumps, now, transaction
from .embed_storage import migrate_sources, source_data, stored_data
from .errors import ApiError
from .guard import check_guard
from .stream_settings import check_stream_settings, stream_write
from .visibility import check_save

Item = dict[str, Any]

INVALID = "The content doesn't validate. Fix the listed fields and resend."


def to_item(r: Any) -> Item:
    return {
        "id": r["id"],
        "kind": r["kind"],
        "slug": r["slug"],
        "version": r["version"],
        "data": json.loads(r["data"]),
        "deleted": bool(r["deleted"]),
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
    }


def _new_id(kind: str) -> str:
    return f"{PREFIX[kind]}_{secrets.token_hex(6)}"


# --- validation ----------------------------------------------------------------------


def _quoted(expected: str) -> list[str]:
    return re.findall(r"'([^']*)'", expected)


def problems_of(err: ValidationError) -> list[dict[str, str]]:
    """Pydantic's errors as zod's issues: {field: path joined by ".", problem}."""
    out: list[dict[str, str]] = []
    unknown: dict[str, list[str]] = {}
    for e in err.errors():
        loc = [str(x) for x in e["loc"]]
        t = e["type"]
        if t == "extra_forbidden":
            unknown.setdefault(".".join(loc[:-1]), []).append(loc[-1])
            continue
        field = ".".join(loc)
        if t == "value_error":
            problem = str(e["msg"]).removeprefix("Value error, ")
        elif t == "missing":
            problem = "Invalid input: expected string, received undefined"
        elif t in ("literal_error", "enum"):
            opts = "|".join(
                f'"{x}"' for x in _quoted(str((e.get("ctx") or {}).get("expected", "")))
            )
            problem = f"Invalid option: expected one of {opts}"
        elif t in ("bool_type", "bool_parsing"):
            problem = "Invalid input: expected boolean"
        elif t in ("model_type", "model_attributes_type", "dict_type"):
            problem = "Invalid input: expected object"
        elif t == "list_type":
            problem = "Invalid input: expected array"
        else:
            problem = str(e["msg"])
        out.append({"field": field, "problem": problem})
    for field, keys in unknown.items():
        names = ", ".join(f'"{k}"' for k in keys)
        out.append(
            {"field": field, "problem": f"Unrecognized key{'s' if len(keys) > 1 else ''}: {names}"}
        )
    return out


def validate(kind: str, data: Any) -> dict[str, Any]:
    if kind not in KINDS:
        raise ApiError(422, "invalid", f"kind must be one of: {', '.join(KINDS)}.")
    # Cards called their badge "status" before it was renamed (it was easy to
    # read as a publishing state).
    if kind == "card" and isinstance(data, dict) and "status" in data and "badge" not in data:
        rest = {k: v for k, v in data.items() if k != "status"}
        data = {**rest, "badge": data["status"]}
    # The site's entries heading became its first stream when streams arrived.
    if kind == "site" and isinstance(data, dict) and "entries_title" in data:
        rest = {k: v for k, v in data.items() if k != "entries_title"}
        data = (
            rest
            if "streams" in rest
            else {**rest, "streams": [{"id": "journal", "title": data["entries_title"]}]}
        )
    try:
        out = MODELS[kind].model_validate(data).data()
    except ValidationError as e:
        raise ApiError(422, "invalid", INVALID, {"problems": problems_of(e)}) from None
    if kind == "site":
        try:
            out["embed_sources"] = embed_sources(out["embed_sources"])
        except (ValueError, UnicodeError):
            raise ApiError(422, "invalid", INVALID, {"problems": [{"field": "embed_sources", "problem": "Use distinct public https:// origins, without a path, login, query or fragment."}]}) from None
        ids = [x["id"] for x in out["streams"]]
        bad = [x for x in out["sections"] if x not in ["entries", "cards", "notes", "about", *ids]]
        if bad:
            raise ApiError(
                422,
                "invalid",
                INVALID,
                {
                    "problems": [
                        {
                            "field": "sections",
                            "problem": f"{', '.join(bad)}: not a stream id or one of entries, cards, notes, about (streams: {', '.join(ids)})",
                        }
                    ]
                },
            )
    return out


async def _check_stream(db: Db, kind: str, data: dict[str, Any]) -> None:
    """An entry's stream must be one the site has."""
    if kind != "entry" or not data.get("stream"):
        return
    ids = [x["id"] for x in (await site_data(db, False))["streams"]]
    if str(data["stream"]) not in ids:
        raise ApiError(
            422,
            "invalid",
            INVALID,
            {
                "problems": [
                    {
                        "field": "stream",
                        "problem": f'the site has no stream "{data["stream"]}"; it has: {", ".join(ids)}. Add a stream to the site item first',
                    }
                ]
            },
        )


def slug_for(kind: str, data: dict[str, Any], dated: bool = True) -> str | None:
    """An entry's address, made once when it is created: its date and title
    words, or the title words alone in a stream with dated_addresses false."""
    if kind != "entry":
        return None
    words = unicodedata.normalize("NFKD", str(data["title"]).lower())
    words = re.sub(r"[^a-z0-9]+", "-", words)
    words = re.sub(r"^-|-$", "", words)[:60]
    words = re.sub(r"-$", "", words)
    return f"{data['date']}-{words or 'entry'}" if dated else words or "entry"


async def _dated_stream(db: Db, data: dict[str, Any]) -> bool:
    """Whether the entry's stream gives new entries dated addresses."""
    streams = (await site_data(db, False))["streams"]
    s = next((x for x in streams if x["id"] == data.get("stream")), streams[0])
    return s.get("dated_addresses") is not False


def _take_slug(data: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    """An entry's chosen slug travels in its data but is kept on the item, not in it."""
    rest = dict(data)
    return rest.pop("slug", None), rest


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# --- reads ---------------------------------------------------------------------------


async def get_item(db: Db, id: str) -> Item:
    row = await db.fetchrow("SELECT * FROM items WHERE id = $1", id)
    if not row:
        raise ApiError(404, "not_found", f"No item {id}.")
    return {**to_item(row), "data": await source_data(db, id, row["version"], json.loads(row["data"]))}


async def all_items(db: Db) -> list[Item]:
    return [{**to_item(r), "data": await source_data(db, r["id"], r["version"], json.loads(r["data"]))} for r in await db.fetch("SELECT * FROM items ORDER BY kind, created_at")]


async def site_data(db: Db, live: bool) -> dict[str, Any]:
    """The site item, with defaults filled in, whether or not it has been edited."""
    sql = (
        "SELECT data, version FROM live WHERE item_id = $1"
        if live
        else "SELECT data, version FROM items WHERE id = $1"
    )
    row = await db.fetchrow(sql, SITE_ID)
    return validate("site", await source_data(db, SITE_ID, row["version"], json.loads(row["data"]), live) if row else {})


# --- writes --------------------------------------------------------------------------


async def _write(
    db: Db,
    item: Item,
    expected: int | None,
    action: str,
    actor: str,
    reason: str,
    from_slug: str | None = None,
) -> Item:
    await migrate_sources(db)
    at = now()
    data = dumps(stored_data(item["kind"], item["data"]))
    changed = True
    try:
        async with transaction(db) as c:
            if expected is None:
                await c.execute(
                    "INSERT INTO items (id, kind, slug, version, data, deleted, created_at, updated_at)"
                    " VALUES ($1, $2, $3, 1, $4, FALSE, $5, $5)",
                    item["id"],
                    item["kind"],
                    item["slug"],
                    data,
                    at,
                )
            else:
                row = await c.fetchrow(
                    "UPDATE items SET data = $1, slug = $2, deleted = $3, version = version + 1,"
                    " updated_at = $4 WHERE id = $5 AND version = $6 RETURNING id",
                    data,
                    item["slug"],
                    bool(item["deleted"]),
                    at,
                    item["id"],
                    expected,
                )
                changed = row is not None
            # The revision is written only if the item now has the new version,
            # so a lost race leaves no stray history.
            if changed:
                await c.execute(
                    "INSERT INTO revisions (item_id, version, action, data, deleted, actor, reason, created_at)"
                    " SELECT id, version, $1, data, deleted, $2, $3, $4 FROM items"
                    " WHERE id = $5 AND version = $6",
                    action,
                    actor,
                    reason,
                    at,
                    item["id"],
                    item["version"],
                )
                if item["kind"] == "site":
                    await stream_write(c, item["version"], item["data"])
                    await c.execute("INSERT INTO site_embed_sources (version,sources) VALUES ($1,$2)", item["version"], dumps(item["data"].get("embed_sources", [])))
                    if item["data"].get("ai_training_disabled"):
                        await c.execute("INSERT INTO site_fields (version,key,value) VALUES ($1,'ai_training_disabled','true')",item["version"])
                    if item["data"].get("private"):
                        await c.execute("INSERT INTO site_fields (version,key,value) VALUES ($1,'private','true')",item["version"])
                    if item["data"].get("broker"):
                        await c.execute("INSERT INTO site_fields (version,key,value) VALUES ($1,'broker',$2)", item["version"], dumps(item["data"]["broker"]))
                # A changed address is remembered, so the old one can send visitors on.
                if (
                    expected is not None
                    and from_slug
                    and item["slug"]
                    and from_slug != item["slug"]
                ):
                    await c.execute(
                        "INSERT INTO slug_history (item_id, version, slug, new_slug, created_at)"
                        " VALUES ($1, $2, $3, $4, $5)",
                        item["id"],
                        item["version"],
                        from_slug,
                        item["slug"],
                        at,
                    )
    except asyncpg.UniqueViolationError as e:
        if "slug" in (e.constraint_name or ""):
            raise ApiError(
                409,
                "slug_taken",
                f"Another entry already has the address {item['slug']}. Choose a different slug, or change the title.",
            ) from None
        if expected is None:
            raise
        changed = False
    if expected is not None and not changed:
        current = await get_item(db, item["id"])
        raise ApiError(
            409,
            "version_conflict",
            f"Item {item['id']} is at version {current['version']}, not {expected}. Re-read it and redo your change.",
            {"current_version": current["version"]},
        )
    return await get_item(db, item["id"])


async def create_item(
    db: Db,
    actor: str,
    kind: str,
    input: Any,
    idempotency_key: str | None,
    fetcher: Any = None,
) -> Item:
    await migrate_sources(db)
    data = validate(kind, input)
    if kind == "site":
        check_stream_settings(data)
    check_guard(data)
    await _check_stream(db, kind, data)
    await check_save(db, kind, None, data, None)
    req_hash = _sha(dumps([kind, data]))
    if idempotency_key:
        prior = await db.fetchrow(
            "SELECT request_hash, response FROM idempotency WHERE actor = $1 AND key = $2",
            actor,
            idempotency_key,
        )
        if prior:
            if prior["request_hash"] != req_hash:
                raise ApiError(
                    409,
                    "idempotency_mismatch",
                    "This idempotency key was used for a different request.",
                )
            return {**json.loads(prior["response"]), "replayed": True}
    if kind == "site":
        if await db.fetchrow("SELECT version FROM items WHERE id = $1", SITE_ID):
            raise ApiError(409, "exists", "The site item already exists. Use item_update.")
    id = SITE_ID if kind == "site" else _new_id(kind)
    # After the replay check, so a retried create doesn't fetch its images again.
    chosen, rest = _take_slug(data)
    slug = (
        (chosen or slug_for(kind, rest, await _dated_stream(db, rest))) if kind == "entry" else None
    )
    stored = await media.localize(db, kind, rest, fetcher)
    item = await _write(
        db,
        {
            "id": id,
            "kind": kind,
            "slug": slug,
            "version": 1,
            "data": stored,
            "deleted": False,
        },
        None,
        "create",
        actor,
        "",
    )
    if idempotency_key:
        await db.execute(
            "INSERT INTO idempotency (actor, key, request_hash, response, created_at)"
            " VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
            actor,
            idempotency_key,
            req_hash,
            dumps(item),
            now(),
        )
    return item


async def update_item(
    db: Db,
    actor: str,
    id: str,
    version: int,
    patch: dict[str, Any],
    reason: str = "",
    fetcher: Any = None,
) -> Item:
    current = await get_item(db, id)
    if current["deleted"]:
        raise ApiError(409, "deleted", f"Item {id} is removed. Roll it back first.")
    chosen, checked = _take_slug(validate(current["kind"], {**current["data"], **patch}))
    if current["kind"] == "site":
        check_stream_settings(checked)
    check_guard(checked)
    await _check_stream(db, current["kind"], checked)
    await check_save(db, current["kind"], id, checked, _vis_before(current))
    data = await media.localize(db, current["kind"], checked, fetcher)
    return await _write(
        db,
        {
            **current,
            "data": data,
            "slug": chosen
            or (
                current["slug"] if current["slug"] is not None else slug_for(current["kind"], data)
            ),
            "version": version + 1,
        },
        version,
        "update",
        actor,
        reason,
        current["slug"],
    )


async def remove_item(db: Db, actor: str, id: str, version: int, reason: str = "") -> Item:
    current = await get_item(db, id)
    if current["kind"] == "site":
        raise ApiError(422, "invalid", "The site item can't be removed; change it instead.")
    return await _write(
        db, {**current, "deleted": True, "version": version + 1}, version, "remove", actor, reason
    )


async def history(db: Db, id: str) -> list[dict[str, Any]]:
    await get_item(db, id)
    rows = await db.fetch(
        "SELECT version, action, data, deleted, actor, reason, created_at FROM revisions"
        " WHERE item_id = $1 ORDER BY version DESC",
        id,
    )
    moves = await db.fetch(
        "SELECT version, slug, new_slug FROM slug_history WHERE item_id = $1", id
    )
    moved = {m["version"]: {"from": m["slug"], "to": m["new_slug"]} for m in moves}
    return [
        {
            **dict(r),
            "data": await source_data(db, id, r["version"], json.loads(r["data"])),
            "deleted": bool(r["deleted"]),
            **({"address_change": moved[r["version"]]} if r["version"] in moved else {}),
        }
        for r in rows
    ]


async def rollback(
    db: Db, actor: str, id: str, to_version: int, version: int, reason: str = ""
) -> Item:
    current = await get_item(db, id)
    old = await db.fetchrow(
        "SELECT data, deleted FROM revisions WHERE item_id = $1 AND version = $2", id, to_version
    )
    if not old:
        raise ApiError(404, "not_found", f"Item {id} has no version {to_version}.")
    data = await source_data(db, id, to_version, json.loads(old["data"]))
    # A rollback never changes a card's visibility; that stays an explicit change.
    if current["kind"] == "card":
        vis = current["data"].get("visibility")
        data = {**data, "visibility": "public" if vis is None else vis}
    check_guard(data)
    if not old["deleted"]:
        await check_save(db, current["kind"], id, data, _vis_before(current))
    return await _write(
        db,
        {
            **current,
            "data": data,
            "deleted": bool(old["deleted"]),
            "slug": current["slug"]
            if current["slug"] is not None
            else slug_for(current["kind"], data),
            "version": version + 1,
        },
        version,
        "rollback",
        actor,
        reason or f"back to version {to_version}",
    )


def _vis_before(item: Item) -> str | None:
    if item["kind"] != "card":
        return None
    v = item["data"].get("visibility")
    return "public" if v is None else str(v)


async def restore(
    db: Db, actor: str, id: str, version: int, data: dict[str, Any], deleted: bool, reason: str
) -> Item:
    """Put an item back to `data` (or removed) as a new version, for a
    whole-site revert; the guard runs as on every write."""
    current = await get_item(db, id)
    if not deleted:
        check_guard(data)
    return await _write(
        db,
        {
            **current,
            "data": data,
            "deleted": deleted,
            "slug": current["slug"]
            if current["slug"] is not None
            else slug_for(current["kind"], data),
            "version": version + 1,
        },
        version,
        "revert",
        actor,
        reason,
    )


_MOVED = re.compile(r"^/([a-z][a-z0-9-]{0,29})/([a-z0-9-]{1,80})/?\Z")


async def moved_address(
    db: Db, entries: list[dict[str, Any]], streams: list[dict[str, Any]], path: str
) -> str | None:
    """Where an entry's old address (/<stream>/<old slug>/, or /e/<old slug>/)
    leads now: the page of the entry that last had that slug, if it is live."""
    m = _MOVED.search(path)
    if not m:
        return None
    row = await db.fetchrow(
        "SELECT item_id FROM slug_history WHERE slug = $1"
        " ORDER BY created_at DESC, version DESC LIMIT 1",
        m.group(2),
    )
    e = next((x for x in entries if x["id"] == row["item_id"]), None) if row else None
    if not e or e["page"] == path:
        return None
    s = next((x for x in streams if x["id"] == e["stream"]), None)
    ok = s and m.group(1) in (s.get("path") or s["id"], s["id"], "e")
    return e["page"] if ok else None


async def staged(db: Db) -> list[Item]:
    """Items whose current state differs from what is live: what an approval can cover."""
    rows = await db.fetch(
        "SELECT i.*, l.version AS live_version FROM items i LEFT JOIN live l ON l.item_id = i.id"
        " WHERE (l.item_id IS NULL AND NOT i.deleted) OR (l.item_id IS NOT NULL AND l.version <> i.version)"
        " ORDER BY i.updated_at"
    )
    return [{**to_item(r), "data": await source_data(db, r["id"], r["version"], json.loads(r["data"])), "live_version": r["live_version"]} for r in rows]
