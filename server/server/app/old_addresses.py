"""Addresses a site had on the older engine, sent on to where the same thing
lives now (a server-edition extra, SPEC §9; only sites moved over from an
older engine have such addresses).

- A stored image, /media/<20 hex>.<ext>: the older engine named images by a
  shorter prefix of the same hash. It answers 301 to /media/<name> when
  exactly one stored image's name starts with that prefix and ends with
  that extension.
- A file the older engine shipped in /static/ that the site text pointed at
  (its first hero image): the converter stores the bytes as media and
  records the old path in `old_addresses`.

Either way the image must be published (S1): nothing unpublished is found
through an old address.
"""

import re

from .db import Db
from .media import published

OLD_MEDIA = re.compile(r"^/media/([0-9a-f]{20})\.(jpg|png|webp)\Z")
_STATIC = re.compile(r"^/static/[A-Za-z0-9._-]{1,80}\Z")


async def lookup(db: Db, path: str) -> str | None:
    """Where an old address leads now, or None."""
    m = OLD_MEDIA.search(path)
    if m:
        rows = await db.fetch(
            "SELECT name FROM media WHERE name LIKE $1 LIMIT 2", f"{m.group(1)}%.{m.group(2)}"
        )
        if len(rows) != 1:
            return None
        name = rows[0]["name"]
    elif _STATIC.search(path):
        target = await db.fetchval("SELECT target FROM old_addresses WHERE path = $1", path)
        if not target or not target.startswith("/media/"):
            return None
        name = target.removeprefix("/media/")
    else:
        return None
    return f"/media/{name}" if await published(db, name) else None
