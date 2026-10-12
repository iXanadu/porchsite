"""Whether a newer Porchsite release is published (SPEC §4, "Updates").
Informational only: the site never downloads, installs or applies anything.
It reads HOME/latest.json at most once a day (the answer is kept in the
database, table kv_cache; a failed fetch is silent and tried again the next
day), and site_state and the owner's review pages say what it found. The
assistant updates on the owner's say-so, following the self-hosting guide's
"Updating the server edition". Port of cloudflare/src/update.ts.
"""

import asyncio
import json
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from .db import Db
from .home import HOME
from .html import esc

LATEST_URL = f"{HOME}/latest.json"
HOW = f"{HOME}/docs/self-hosting/#updating-the-server-edition"
CACHE_KEY = "porchsite:update-check"
DAY_MS = 86_400_000
TIMEOUT_S = 3.0
# A published release id: <UTC date>-<commit>. Anything else (dev, test, a
# local build) never checks.
RELEASE_ID = re.compile(r"^(\d{4}\.\d{2}\.\d{2})-[0-9a-f]{7,40}$")


async def _fetch(url: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=TIMEOUT_S, follow_redirects=False) as c:
        return await c.get(url, headers={"Accept": "application/json"})


class _Runtime:
    """For tests: the running release (None: the app's own) and the fetch."""

    release: str | None = None
    fetch: Callable[[str], Awaitable[httpx.Response]] = staticmethod(_fetch)


runtime = _Runtime()


def _strings(v: Any) -> list[str]:
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def _release(v: dict[str, Any], id: Any) -> dict[str, Any] | None:
    if not isinstance(id, str) or not RELEASE_ID.match(id):
        return None
    return {
        "release": id,
        "security": v.get("security") is True,
        "reconnect": v.get("reconnect") is True,
        "migrations": _strings(v.get("migrations")),
        "changes": _strings(v.get("changes")),
    }


def parse_latest(body: Any) -> dict[str, Any] | None:
    """latest.json, reduced to what the notice needs: newest first."""
    if not isinstance(body, dict):
        return None
    top = _release(body, body.get("version"))
    if not top:
        return None
    listed = body.get("releases")
    rs = []
    if isinstance(listed, list):
        for r in listed:
            if isinstance(r, dict) and (x := _release(r, r.get("release"))):
                rs.append(x)
    ok = bool(rs) and rs[0]["release"] == top["release"]
    return {"latest": top["release"], "releases": rs[:200] if ok else [top]}


def compare(running: str, latest: str | None, releases: list[dict[str, Any]]) -> dict[str, Any]:
    """What the running release lacks, from the cached releases (pure)."""
    m = RELEASE_ID.match(running)
    lm = RELEASE_ID.match(latest) if latest else None
    if not m or not lm or latest == running:
        return {"available": False}
    at = next((i for i, r in enumerate(releases) if r["release"] == running), -1)
    if at >= 0:
        newer = releases[:at]
    elif lm.group(1) > m.group(1):
        newer = [r for r in releases if RELEASE_ID.match(r["release"]).group(1) > m.group(1)]  # type: ignore[union-attr]
    else:
        return {"available": False}  # a build that isn't published, or newer than what is
    if not newer:
        return {"available": False}
    return {
        "available": True,
        "latest": latest,
        "security": any(r["security"] for r in newer),
        "changes": [c for r in newer for c in r["changes"]],
        "migrations": sorted({m for r in newer for m in r["migrations"]}),
        "reconnect": any(r["reconnect"] for r in newer),
        "how": HOW,
    }


async def _read_cache(db: Db) -> dict[str, Any] | None:
    try:
        raw = await db.fetchval("SELECT value FROM kv_cache WHERE key = $1", CACHE_KEY)
        v = json.loads(raw) if raw else None
        return v if isinstance(v, dict) and isinstance(v.get("checked_at"), int) else None
    except Exception:
        return None


async def check(db: Db, release: str, now: int | None = None) -> dict[str, Any]:
    """The update notice for this site: asks HOME at most once a day. Never raises."""
    running = runtime.release if runtime.release is not None else release
    if not RELEASE_ID.match(running):
        return {"available": False}
    now = int(time.time() * 1000) if now is None else now
    cached = await _read_cache(db)
    if not cached or now - cached["checked_at"] >= DAY_MS or now < cached["checked_at"]:
        fresh = None
        try:
            r = await asyncio.wait_for(runtime.fetch(LATEST_URL), TIMEOUT_S)
            if r.status_code == 200:
                fresh = parse_latest(r.json())
        except Exception:
            pass  # Silent: tried again tomorrow.
        cached = {
            "checked_at": now,
            "latest": fresh["latest"] if fresh else (cached or {}).get("latest"),
            "releases": fresh["releases"] if fresh else (cached or {}).get("releases") or [],
        }
        try:
            await db.execute(
                "INSERT INTO kv_cache (key, value, updated_at) VALUES ($1, $2, $3) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
                CACHE_KEY,
                json.dumps(cached),
                now,
            )
        except Exception:
            pass  # A cache that can't be written only means asking again next time.
    return compare(running, cached.get("latest"), cached.get("releases") or [])


def notice_html(u: dict[str, Any]) -> str:
    """The owner's one quiet line, or nothing."""
    if not u.get("available"):
        return ""
    if u["security"]:
        return f'<p class="warn"><b>Security update:</b> a newer Porchsite is available ({esc(u["latest"])}). Ask your assistant to update it.</p>'
    return f'<p class="meta">A newer Porchsite is available ({esc(u["latest"])}). Ask your assistant to update it.</p>'
