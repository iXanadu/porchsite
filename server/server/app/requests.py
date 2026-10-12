"""Asking the community for a theme that doesn't exist yet, and sharing a
look this site made. The request goes privately to a queue (home.HOME), sent
from this site's own server; the queue checks it came from here by fetching
a one-time proof (/.well-known/sitekeeper-proof/<nonce>, answered with
answer_proof). A curator groups requests; this site can see whether its
requests were answered. Port of cloudflare/src/requests.ts.
"""

import base64
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from .db import Db, dumps, iso, now, transaction
from .errors import ApiError
from .fetch import Fetcher, fetch
from .home import HOME

QUEUE = HOME
PROOF_MINUTES = 5


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _cutoff() -> str:
    return iso(datetime.now(UTC) - timedelta(minutes=PROOF_MINUTES))


async def _new_proof(db: Db) -> str:
    nonce = _b64url(secrets.token_bytes(24))
    async with transaction(db) as c:
        await c.execute("DELETE FROM request_proofs WHERE created_at < $1", _cutoff())
        await c.execute(
            "INSERT INTO request_proofs (nonce, created_at) VALUES ($1, $2)", nonce, now()
        )
    return nonce


async def answer_proof(db: Db, nonce: str) -> bool:
    """The queue asking "did you send this?": yes once, for a few minutes."""
    row = await db.fetchrow(
        "DELETE FROM request_proofs WHERE nonce = $1 AND created_at > $2 RETURNING nonce",
        nonce,
        _cutoff(),
    )
    return bool(row)


async def _send(fetcher: Fetcher, path: str, body: Any) -> dict[str, Any]:
    try:
        r = await fetcher(
            f"{QUEUE}{path}",
            method="POST",
            headers={"Content-Type": "application/json"},
            content=dumps(body),
        )
    except Exception:
        r = None
    if r is None:
        raise ApiError(
            502, "queue_unreachable", "The Porchsite request queue didn't answer. Try again later."
        )
    try:
        j = r.json()
        if not isinstance(j, dict):
            j = {}
    except ValueError:
        j = {}
    if not r.is_success:
        raise ApiError(
            429 if r.status_code == 429 else 502,
            j.get("error") or "queue_refused",
            j.get("message") or f"The request queue answered {r.status_code}.",
        )
    return j


async def file(
    db: Db,
    origin: str,
    actor: str,
    input: dict[str, Any],
    fetcher: Fetcher = fetch,
) -> dict[str, Any]:
    """File a request: input is {type, title, description, examples}."""
    j = await _send(
        fetcher, "/requests", {"origin": f"{origin}/", "nonce": await _new_proof(db), **input}
    )
    await db.execute(
        "INSERT INTO theme_requests (id, title, filed_by, created_at) VALUES ($1, $2, $3, $4)"
        " ON CONFLICT DO NOTHING",
        j.get("id"),
        input["title"],
        actor,
        now(),
    )
    return {"id": j.get("id"), "status": j.get("status")}


async def mine(db: Db, fetcher: Fetcher = fetch) -> list[dict[str, Any]]:
    """This site's requests and where each stands; status "unknown" if the queue is down."""
    rows = await db.fetch(
        "SELECT id, title, created_at FROM theme_requests ORDER BY created_at DESC LIMIT 50"
    )
    if not rows:
        return []
    try:
        r = await fetcher(f"{QUEUE}/requests/status?ids={','.join(x['id'] for x in rows)}")
    except Exception:
        r = None
    status: dict[str, dict[str, Any]] = {}
    if r is not None and r.is_success:
        for s in r.json()["requests"]:
            status[s["id"]] = s
    return [
        {
            **dict(x),
            "status": status.get(x["id"], {}).get("status") or "unknown",
            "theme": status.get(x["id"], {}).get("theme") or "",
        }
        for x in rows
    ]


# --- sharing a look this site made ---------------------------------------------------


async def submit(
    db: Db,
    origin: str,
    actor: str,
    name: str,
    note: str,
    fetcher: Fetcher = fetch,
    author_x: str | None = None,
) -> dict[str, Any]:
    """Share a look. author_x (optional): the X handle to credit, without the @;
    the queue answers with a claim code the maker posts from that account, and
    the look is credited only once the curator has seen the post."""
    row = await db.fetchrow("SELECT version, package, source FROM themes WHERE name = $1", name)
    if not row or row["source"] != "private":
        raise ApiError(
            404,
            "no_such_look",
            f"This site has no look of its own called {name}. theme_create makes one.",
        )
    j = await _send(
        fetcher,
        "/submissions",
        {
            "origin": f"{origin}/",
            "nonce": await _new_proof(db),
            "package": row["package"],
            "note": note,
            **({"author_x": author_x} if author_x else {}),
        },
    )
    await db.execute(
        "INSERT INTO theme_submissions (id, name, version, submitted_by, created_at)"
        " VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        j.get("id"),
        name,
        row["version"],
        actor,
        now(),
    )
    return {
        "id": j.get("id"),
        "status": j.get("status"),
        **({"credit": j["credit"]} if j.get("credit") else {}),
    }


CREDIT = ("waiting", "credited", "not credited")


async def my_submissions(db: Db, fetcher: Fetcher = fetch) -> list[dict[str, Any]]:
    """This site's shared looks and where each stands. A look that claimed
    credit also has credit: waiting (the curator hasn't checked the post yet),
    credited, or not credited."""
    rows = await db.fetch(
        "SELECT id, name, version, created_at FROM theme_submissions ORDER BY created_at DESC LIMIT 50"
    )
    if not rows:
        return []
    try:
        r = await fetcher(f"{QUEUE}/submissions/status?ids={','.join(x['id'] for x in rows)}")
    except Exception:
        r = None
    status: dict[str, dict[str, Any]] = {}
    if r is not None and r.is_success:
        for s in r.json()["submissions"]:
            status[s["id"]] = s
    out = []
    for x in rows:
        s = status.get(x["id"], {})
        one = {**dict(x), "status": s.get("status") or "unknown", "note": s.get("note") or ""}
        if s.get("credit") in CREDIT:
            one["credit"] = s["credit"]
        out.append(one)
    return out
