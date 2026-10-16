"""Access precedes content construction, redirects and media lookups."""

import json
import re

from starlette.responses import Response

from . import owner

BLANK = '<!doctype html><meta name="robots" content="noindex"><title></title>'
PRIVATE_HEADERS = {"Cache-Control": "private, no-store"}
ROLLBACK_WARNING = "This makes the site public. Older releases do not know private mode. Roll back only to the minimum release or newer, or turn private off first on purpose. Proceed only after the owner explicitly approves this exposure."


async def live_private(db):
    row = await db.fetchrow(
        "SELECT f.value FROM live l JOIN site_fields f ON f.version = l.version AND f.key = 'private' AND f.approved = 1 JOIN private_approvals a ON a.version = l.version WHERE l.item_id = 'site'"
    )
    return bool(row and json.loads(row["value"]) is True)


async def private_floor(db, release):
    if not await live_private(db):
        return None
    if re.fullmatch(r"\d{4}\.\d{2}\.\d{2}-[a-f0-9]+", release):
        await db.execute(
            "UPDATE auth_state SET private_floor = $1 WHERE id = 1 AND private_floor = ''", release
        )
    return (await db.fetchval("SELECT private_floor FROM auth_state WHERE id = 1")) or "unknown"


async def rollback_state(db, release):
    floor = await private_floor(db, release)
    return {"private_floor": floor, "explanation": ROLLBACK_WARNING if floor else ""}


def open_path(path):
    return bool(
        re.match(r"/(?:login|setup|recover|oauth|\.well-known|upload|passkey|invite)(?:/|$)", path)
    ) or path in ("/mcp", "/authorize")


async def access(db, req):
    path = req.url.path
    is_private = await live_private(db)
    gated = not open_path(path)
    response = None
    if is_private and path == "/robots.txt":
        response = Response(
            "User-agent: *\nDisallow: /\n", headers=PRIVATE_HEADERS, media_type="text/plain"
        )
    elif (is_private and gated) or path == "/authorize":
        is_owner = await owner.signed_in(db, req)
        reader = not is_owner and await owner.reader_signed_in(db, req)
        if reader and (path == "/authorize" or path == "/review" or path.startswith("/review/")):
            response = Response(status_code=303, headers={"Location": "/", **PRIVATE_HEADERS})
        elif is_private and gated and not is_owner and not reader:
            response = (
                Response(status_code=204, headers=PRIVATE_HEADERS)
                if path == "/collect"
                else Response(
                    BLANK,
                    status_code=404,
                    headers={**PRIVATE_HEADERS, "X-Robots-Tag": "noindex"},
                    media_type="text/html",
                )
            )
    return is_private, gated, response


def no_store(response):
    response.headers["Cache-Control"] = "private, no-store"
    for name in ("ETag", "Last-Modified"):
        if name in response.headers:
            del response.headers[name]
    return response


async def with_rollback(db, release, state):
    rollback = await rollback_state(db, release)
    return {**state, "rollback": rollback} if rollback["private_floor"] else state
