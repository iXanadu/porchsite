"""Card visibility (SPEC §3): public, mention or private. A private card is
never shown and its name may not appear in anything public; a mention card
shows its name and description only, and an entry names it at most once in
its summary and once in its body. Checked when content is saved (with the
guard, S6) and again when anything is published. Port of
cloudflare/src/visibility.ts.
"""

import json
import re
from typing import Any

from .db import Db
from .errors import ApiError

RANK = {"private": 0, "mention": 1, "public": 2}

Data = dict[str, Any]


def _vis(d: Data) -> str:
    v = d.get("visibility")
    return "public" if v is None else str(v)


def _text(v: Any, out: list[str] | None = None) -> str:
    """Every string in a value, joined, as the guard reads content."""
    out = [] if out is None else out

    def walk(x: Any) -> None:
        if isinstance(x, str):
            out.append(x)
        elif isinstance(x, list):
            for y in x:
                walk(y)
        elif isinstance(x, dict):
            for y in x.values():
                walk(y)

    walk(v)
    return "\n".join(out)


def name_rule(names: list[str]) -> re.Pattern | None:
    """A whole-word, case-insensitive match for any of these names, or None."""
    clean = sorted(dict.fromkeys(n.strip() for n in names if n.strip()), key=len, reverse=True)
    if not clean:
        return None
    alts = "|".join(re.escape(n) for n in clean)
    return re.compile(rf"(?<![A-Za-z0-9_])(?:{alts})(?![A-Za-z0-9_])", re.I)


async def _cards(db: Db) -> list[dict[str, Any]]:
    rows = await db.fetch(
        "SELECT id, data FROM items WHERE kind = 'card' AND NOT deleted ORDER BY created_at, id COLLATE \"C\""
    )
    return [{"id": r["id"], "data": json.loads(r["data"])} for r in rows]


def _with_vis(cards: list[dict[str, Any]], vis: str) -> list[dict[str, str]]:
    return [
        {"id": c["id"], "name": str(c["data"].get("name") or "")}
        for c in cards
        if _vis(c["data"]) == vis
    ]


def _checked_part(kind: str, data: Data) -> Data:
    """What a card's own text is checked as: everything but its name (a card may name itself)."""
    if kind != "card":
        return data
    return {k: v for k, v in data.items() if k != "name"}


async def check_save(db: Db, kind: str, id: str | None, data: Data, before: str | None) -> None:
    """On every save. `before` is the item's visibility before this write (None for a new item)."""
    others = [c for c in await _cards(db) if c["id"] != id]
    private_card = kind == "card" and _vis(data) == "private"
    # A private card's own text never goes public, so it may name anything.
    if not private_card:
        priv = _with_vis(others, "private")
        rx = name_rule([c["name"] for c in priv])
        found = rx.findall(_text(_checked_part(kind, data))) if rx else []
        if found:
            hit = next((c for c in priv if name_rule([c["name"]]).search(found[0])), None)
            raise ApiError(
                422,
                "content_guard",
                'This names a private card. Leave its name out (say "an unannounced project"), or make the card public first.',
                {"rule": "a private card's name", "card": hit["id"] if hit else ""},
            )
    if kind == "entry":
        for c in _with_vis(others, "mention"):
            rx = name_rule([c["name"]])
            if not rx:
                continue
            for field in ("summary", "body"):
                value = data.get(field)
                if len(rx.findall("" if value is None else str(value))) > 1:
                    raise ApiError(
                        422,
                        "mention_limit",
                        f'This entry names "{c["name"].strip()}" more than once in its {field}. A card shown as a mention gets one line: name it once, or make the card public.',
                        {"card": c["id"], "field": field},
                    )
    # Making a card private must not leave its name in other items.
    if private_card and before != "private":
        rx = name_rule([str(data.get("name") or "")])
        if not rx:
            return
        rows = await db.fetch(
            'SELECT id, kind, data FROM items WHERE NOT deleted ORDER BY created_at, id COLLATE "C"'
        )
        users = []
        for r in rows:
            if r["id"] == id:
                continue
            d = json.loads(r["data"])
            if r["kind"] == "card" and _vis(d) == "private":
                continue
            if rx.search(_text(d)):
                users.append(r["id"])
        if users:
            raise ApiError(
                409,
                "name_in_use",
                f'Other items still name "{str(data["name"]).strip()}". Change them first, then make the card private.',
                {"items": users},
            )


async def check_public(db: Db, rows: list[dict[str, Any]]) -> None:
    """Before anything goes live: no public text in the site as it would be
    (`rows`, shaped like `live`: id, kind, data) may name a private card,
    private there or in the current, unapproved content."""
    priv: dict[str, str] = {}
    for r in rows:
        if r["kind"] == "card" and _vis(r["data"]) == "private":
            priv[r["id"]] = str(r["data"].get("name") or "")
    for c in _with_vis(await _cards(db), "private"):
        priv[c["id"]] = c["name"]
    if not priv:
        return
    problems = []
    for r in rows:
        d = r["data"]
        if r["kind"] == "card" and _vis(d) == "private":
            continue
        if r["kind"] == "entry" and d.get("status") == "draft":
            continue
        rx = name_rule([n for i, n in priv.items() if i != r["id"]])
        if rx and rx.search(_text(_checked_part(r["kind"], d))):
            label = next(
                (d[k] for k in ("title", "name", "text") if d.get(k) is not None), r["kind"]
            )
            problems.append({"id": r["id"], "kind": r["kind"], "label": label})
    if problems:
        names = ", ".join(p["label"] for p in problems)
        raise ApiError(
            422,
            "content_guard",
            f"Some items can't go public as they stand: they name a private card ({names}). Change them, then try again.",
            {"items": problems},
        )


async def raises(db: Db, items: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Cards these item versions would show more of than the live site does
    (private → mention → public): [{id, name, from, to}]."""
    out = []
    for it in items:
        if it["kind"] != "card":
            continue
        rev = await db.fetchrow(
            "SELECT data, deleted FROM revisions WHERE item_id = $1 AND version = $2",
            it["id"],
            it["version"],
        )
        live = await db.fetchrow("SELECT data FROM live WHERE item_id = $1", it["id"])
        if not rev or rev["deleted"] or not live:
            continue
        now = json.loads(rev["data"])
        was, to = _vis(json.loads(live["data"])), _vis(now)
        if RANK.get(to, 2) > RANK.get(was, 2):
            out.append({"id": it["id"], "name": str(now.get("name") or ""), "from": was, "to": to})
    return out
