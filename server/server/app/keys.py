"""Assistant keys (SPEC §4): a bearer token the owner makes on
/review/assistants for an assistant whose app can't add a connector with
sign-in. Sent to /mcp as "Authorization: Bearer psk_…", it reaches the same
tools as a connected assistant: drafting only, everything waits for the
owner. Only its SHA-256 is kept; it expires after KEY_DAYS and can be
revoked. Port of cloudflare/src/keys.ts.
"""

import base64
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from .db import Db

PREFIX = "psk_"
KEY_DAYS = 90


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def create(db: Db, name: str) -> dict[str, str]:
    """A new key: the token is returned once and never stored."""
    token = PREFIX + base64.urlsafe_b64encode(secrets.token_bytes(24)).decode().rstrip("=")
    id = f"key_{secrets.token_hex(6)}"
    now = datetime.now(UTC)
    expires_at = _iso(now + timedelta(days=KEY_DAYS))
    await db.execute(
        "INSERT INTO assistant_keys (id, name, key_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
        id,
        name,
        _hash(token),
        _iso(now),
        expires_at,
    )
    return {"id": id, "token": token, "expires_at": expires_at}


async def list(db: Db) -> list[dict[str, Any]]:  # noqa: A001 (keys.list, as in TS)
    """Keys that still work, newest first."""
    rows = await db.fetch(
        "SELECT id, name, created_at, expires_at, last_used_at FROM assistant_keys"
        " WHERE revoked_at IS NULL AND expires_at > $1 ORDER BY created_at DESC",
        _iso(datetime.now(UTC)),
    )
    return [dict(r) for r in rows]


async def revoke(db: Db, id: str) -> None:
    await db.execute(
        "UPDATE assistant_keys SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL",
        _iso(datetime.now(UTC)),
        id,
    )


async def lookup(db: Db, token: str, observe=True) -> dict[str, str] | None:
    """The assistant a key stands for, or None when it's unknown, revoked or expired."""
    if not token.startswith(PREFIX):
        return None
    now = _iso(datetime.now(UTC))
    row = await db.fetchrow(
        "SELECT id, name FROM assistant_keys WHERE key_hash = $1 AND revoked_at IS NULL AND expires_at > $2",
        _hash(token),
        now,
    )
    if not row:
        return None
    if observe:
        await db.execute("UPDATE assistant_keys SET last_used_at = $1 WHERE id = $2", now, row["id"])
    return {"client": row["name"], "clientId": f"key:{row['id']}"}
