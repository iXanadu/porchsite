"""Images (SPEC S7: no hotlinks). An image named by https URL in content is
fetched once when the item is saved, checked, stored in the database by a
hash of its bytes, and the content is rewritten to /media/<name>. A published
page then never depends on someone else's host. Port of
cloudflare/src/media.ts (bytes in one bytea column instead of D1 chunks).

Fetching is safe to point at a caller's URL: https only, public addresses
only (fetch.capped_public_fetch), at most MAX_BYTES read.
"""

from .public_artifacts import public_change

import hashlib
import re
from typing import Any

from server.spec.jsutil import NOT_S, S

from .db import Db, now
from .errors import ApiError
from .fetch import Fetcher, capped_public_fetch
from .image_privacy import strip_location

MAX_BYTES = 8 * 1024 * 1024
EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
TYPE = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}

# Image fields per kind, each with the field that must describe it.
IMAGE_FIELDS: dict[str, list[tuple[str, str]]] = {
    "site": [
        ("hero", "hero_alt"),
        ("logo", "logo_alt"),
        ("follow_image", "follow_image_alt"),
        ("share_image", "share_image_alt"),
    ],
    "entry": [("cover", "cover_alt")],
    "card": [("image", "image_alt")],
}
MD_IMAGE = re.compile(rf"!\[([^\]]*)\]\(([^){S[1:-1]}]+)\)")
LOCAL = re.compile(r"^/media/([0-9a-f]{32}\.(?:jpg|png|webp))\Z")
_HTTPS = re.compile(rf"^https://{NOT_S}+\Z")

_default_fetch = capped_public_fetch(MAX_BYTES)


def sniff(b: bytes) -> str | None:
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:4] == b"\x89PNG":
        return "image/png"
    if b[0:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    return None


def _failed(field: str, url: str, why: str) -> ApiError:
    return ApiError(
        422,
        "image_failed",
        f"Couldn't use the image in {field} ({url}): {why}.",
        {"field": field, "image_url": url},
    )


async def _download(url: str, field: str, fetcher: Fetcher) -> tuple[bytes, str]:
    if not _HTTPS.search(url):
        raise _failed(field, url, "it must be a full https:// link to the image")
    try:
        res = await fetcher(url, headers={"Accept": "image/*"})
    except Exception:
        raise _failed(field, url, "that address didn't answer (it must be public)") from None
    if not res.is_success:
        raise _failed(field, url, f"the server answered {res.status_code}")
    too_big = f"it is over {MAX_BYTES // 1024 // 1024} MB; send a smaller copy"
    try:
        declared = int(res.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > MAX_BYTES:
        raise _failed(field, url, too_big)
    parts = bytearray()
    async for part in res.aiter_bytes():
        parts += part
        if len(parts) > MAX_BYTES:
            await res.aclose()
            raise _failed(field, url, too_big)
    data = bytes(parts)
    type_ = sniff(data)
    if not type_:
        raise _failed(field, url, "it isn't a JPEG, PNG or WebP image")
    return data, type_


def size(b: bytes) -> tuple[int, int]:
    """Pixel size from a JPEG, PNG or WebP header; (0, 0) if it can't tell."""

    def at(i: int) -> int:
        return b[i] if 0 <= i < len(b) else 0

    def u16(i: int) -> int:
        return (at(i) << 8) | at(i + 1)

    def u32(i: int) -> int:
        return (at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)

    def le16(i: int) -> int:
        return at(i) | (at(i + 1) << 8)

    def le24(i: int) -> int:
        return at(i) | (at(i + 1) << 8) | (at(i + 2) << 16)

    type_ = sniff(b)
    if type_ == "image/png" and len(b) >= 24:
        return u32(16), u32(20)
    if type_ == "image/jpeg":
        i = 2
        while i + 9 < len(b):
            if b[i] != 0xFF:
                return 0, 0
            marker = b[i + 1]
            # Start-of-frame markers carry the size; skip everything else.
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                return u16(i + 7), u16(i + 5)
            i += 2 + u16(i + 2)
        return 0, 0
    if type_ == "image/webp" and len(b) >= 30:
        chunk = b[12:16]
        if chunk == b"VP8 ":
            return le16(26) & 0x3FFF, le16(28) & 0x3FFF
        if chunk == b"VP8L":
            return (
                1 + (((at(22) & 0x3F) << 8) | at(21)),
                1 + (((at(24) & 0xF) << 10) | (at(23) << 2) | ((at(22) & 0xC0) >> 6)),
            )
        if chunk == b"VP8X":
            return 1 + le24(24), 1 + le24(27)
    return 0, 0


async def store(db: Db, data: bytes, type_: str, source: str) -> str:
    """Store bytes once, by hash; returns the /media path."""
    data = strip_location(data, type_)
    name = f"{hashlib.sha256(data).digest()[:16].hex()}.{EXT[type_]}"
    have = await db.fetchrow("SELECT width FROM media WHERE name = $1", name)
    if have and not have["width"]:
        # Stored before sizes were recorded: fill it in now.
        w, h = size(data)
        if w:
            await public_change(db, "UPDATE media SET width = $1, height = $2 WHERE name = $3", w, h, name)
    if not have:
        w, h = size(data)
        await db.execute(
            "INSERT INTO media (name, type, size, data, source, created_at, width, height)"
            " VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (name) DO NOTHING",
            name,
            type_,
            len(data),
            data,
            source[:500],
            now(),
            w,
            h,
        )
    return f"/media/{name}"


async def _local_path(db: Db, field: str, url: str, fetcher: Fetcher, known: set[str]) -> str:
    local = LOCAL.search(url)
    if local:
        if local.group(1) not in known:
            raise _failed(field, url, "this site has no image by that name")
        return url
    data, type_ = await _download(url, field, fetcher)
    path = await store(db, data, type_, url)
    known.add(LOCAL.search(path).group(1))
    return path


async def localize(
    db: Db, kind: str, data: dict[str, Any], fetcher: Fetcher | None = None
) -> dict[str, Any]:
    """Copy every image an item names into the site, and require a description
    for each. Returns the data with image fields pointing at /media."""
    fetcher = fetcher or _default_fetch
    out = dict(data)
    body_images = (
        list(MD_IMAGE.finditer(out["body"]))
        if kind == "entry" and isinstance(out.get("body"), str)
        else []
    )
    names = set()
    for field, alt in IMAGE_FIELDS.get(kind, []):
        local = LOCAL.search(str(out.get(field) or ""))
        if local and str(out.get(alt) or "").strip():
            names.add(local.group(1))
    for match in body_images:
        local = LOCAL.search(match.group(2))
        if local and match.group(1).strip():
            names.add(local.group(1))
    known = (
        {
            row["name"]
            for row in await db.fetch(
                "SELECT name FROM media WHERE name = ANY($1::text[])", list(names)
            )
        }
        if names
        else set()
    )
    problems: list[dict[str, str]] = []
    for field, alt in IMAGE_FIELDS.get(kind, []):
        url = str(out.get(field) or "")
        if not url:
            continue
        if not str(out.get(alt) or "").strip():
            problems.append(
                {
                    "field": alt,
                    "problem": f"describe the image in {field} in a few words, for people who can't see it",
                }
            )
            continue
        out[field] = await _local_path(db, field, url, fetcher, known)
    if kind == "entry" and isinstance(out.get("body"), str):
        body = out["body"]
        for m in body_images:
            whole, alt_text, url = m.group(0), m.group(1), m.group(2)
            if not alt_text.strip():
                problems.append(
                    {
                        "field": "body",
                        "problem": f"the image {url} needs a description: ![what it shows]({url})",
                    }
                )
                continue
            path = await _local_path(db, "body", url, fetcher, known)
            if path != url:
                body = body.replace(whole, f"![{alt_text}]({path})", 1)
        out["body"] = body
    if problems:
        raise ApiError(
            422,
            "invalid",
            "The content doesn't validate. Fix the listed fields and resend.",
            {"problems": problems},
        )
    return out


async def published(db: Db, name: str) -> bool:
    """Whether a published item uses this image: only then may anyone see it (S1)."""
    if await db.fetchrow("SELECT 1 FROM live WHERE strpos(data, $1) > 0 LIMIT 1", f"/media/{name}"):
        return True
    # A published entry's share card is public too.
    return bool(
        await db.fetchrow(
            "SELECT 1 FROM share_cards s JOIN live l ON l.item_id = s.item_id WHERE s.name = $1 LIMIT 1",
            name,
        )
    )


async def size_of(db: Db, name: str) -> tuple[int, int]:
    """Read-only pixel size; legacy dimensions are measured without persisting."""
    r = await db.fetchrow("SELECT width, height FROM media WHERE name = $1", name)
    if not r:
        return 0, 0
    if r["width"]:
        return r["width"], r["height"]
    data = await db.fetchval("SELECT data FROM media WHERE name = $1", name)
    return size(bytes(data))


async def serve(db: Db, name: str, is_public: bool) -> dict[str, Any] | None:
    """GET /media/<name>: {"body": bytes, "headers": {...}}, or None. A published
    image must revalidate; authenticated copies must never be stored. Access
    and publication are checked by the route before calling this function."""
    row = await db.fetchrow("SELECT type, data FROM media WHERE name = $1", name)
    if not row:
        return None
    return {
        "body": bytes(row["data"]),
        "headers": {
            "Content-Type": TYPE.get(name.split(".")[-1], row["type"]),
            "Cache-Control": "no-cache, no-transform"
            if is_public
            else "private, no-store, no-transform",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    }
