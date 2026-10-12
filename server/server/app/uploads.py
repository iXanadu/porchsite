"""Photos from the person's phone. An assistant can't carry megabytes of image
through a tool call, so it asks for a one-time link instead, sends it to its
person, and they pick the photo and describe it. The link is the only key: it
works once, for 30 minutes. The photo is stored like any other image
(media.py) and, like them, shows publicly only once a published item uses it.
Port of cloudflare/src/uploads.ts (SHRINK_JS, the page script, belongs to
the routes).
"""

import base64
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from . import media
from .db import Db, iso, now
from .errors import ApiError

TTL_MINUTES = 30

Upload = dict[str, Any]


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _shape(r: Any) -> Upload:
    status = "done" if r["media"] else "expired" if r["expires_at"] < now() else "waiting"
    return {
        "id": r["id"],
        "status": status,
        "purpose": r["purpose"],
        "expires_at": r["expires_at"],
        "image": r["media"],
        "alt": r["alt"],
    }


async def create(db: Db, actor: str, purpose: str) -> Upload:
    """A new link. Returns the record and the secret path, which is shown once."""
    id = f"upl_{_b64url(secrets.token_bytes(6))}"
    token = _b64url(secrets.token_bytes(24))
    t = datetime.now(UTC)
    expires = iso(t + timedelta(minutes=TTL_MINUTES))
    await db.execute(
        "INSERT INTO uploads (id, token_hash, purpose, requested_by, created_at, expires_at)"
        " VALUES ($1, $2, $3, $4, $5, $6)",
        id,
        _hash(token),
        purpose[:200],
        actor,
        iso(t),
        expires,
    )
    shaped = _shape(
        {"id": id, "purpose": purpose, "expires_at": expires, "media": None, "alt": None}
    )
    return {**shaped, "path": f"/upload/{token}"}


async def get(db: Db, id: str) -> Upload:
    r = await db.fetchrow(
        "SELECT id, purpose, expires_at, media, alt FROM uploads WHERE id = $1", id
    )
    if not r:
        raise ApiError(404, "not_found", f"No upload {id}.")
    return _shape(r)


async def open(db: Db, token: str) -> Upload | None:  # noqa: A001 (uploads.open, as in TS)
    """The link's upload, if it can still be used."""
    r = await db.fetchrow(
        "SELECT id, purpose, expires_at, media, alt FROM uploads WHERE token_hash = $1",
        _hash(token),
    )
    if not r:
        return None
    u = _shape(r)
    return u if u["status"] == "waiting" else None


async def receive(db: Db, token: str, file: bytes | None, alt: str) -> Upload:
    """Take the photo: check it, store it, close the link."""
    u = await open(db, token)
    if not u:
        raise ApiError(
            410,
            "link_used",
            "This link has been used or has expired. Ask your assistant for a new one.",
        )
    if not alt.strip():
        raise ApiError(
            422, "invalid", "Please describe the photo in a few words, for people who can't see it."
        )
    if not file:
        raise ApiError(422, "invalid", "Choose a photo first.")
    if len(file) > media.MAX_BYTES:
        raise ApiError(
            422,
            "invalid",
            f"That photo is over {media.MAX_BYTES // 1024 // 1024} MB. Try a smaller copy.",
        )
    type_ = media.sniff(file)
    if not type_:
        raise ApiError(
            422,
            "invalid",
            "That isn't a JPEG, PNG or WebP photo. On an iPhone, choose it from Photos rather than Files.",
        )
    path = await media.store(db, file, type_, f"upload {u['id']}")
    # Only the first arrival wins, so a double tap can't swap the photo.
    done = await db.fetchrow(
        "UPDATE uploads SET media = $1, alt = $2, used_at = $3 WHERE id = $4 AND media IS NULL RETURNING id",
        path,
        alt.strip()[:200],
        now(),
        u["id"],
    )
    if not done:
        raise ApiError(410, "link_used", "This link has already been used.")
    return await get(db, u["id"])
