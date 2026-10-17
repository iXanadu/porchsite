"""Exact-version stream configuration, never authority in legacy JSON."""

import json

import asyncpg
from pydantic import ValidationError

from .db import dumps
from .errors import ApiError


def stream_projection(data):
    legacy = {k: v for k, v in data.items() if k != "archive"}
    if "streams" not in data:
        return legacy
    kept = [{k: v for k, v in s.items() if k != "sort"} for s in data["streams"][:8]]
    ids = {s["id"] for s in kept}
    return {
        **legacy,
        "streams": kept,
        **(
            {
                "sections": [
                    s
                    for s in data["sections"]
                    if s in ids or s in ("entries", "cards", "notes", "about")
                ][:12]
            }
            if "sections" in data
            else {}
        ),
    }


def check_stream_settings(data):
    paths = [s["path"] or s["id"] for s in data["streams"]]
    if len(set(paths)) != len(paths):
        raise ApiError(422, "invalid", "Each stream path must be unique.")
    if data["archive"]["enabled"] and any(
        s["id"] == "archive" or (s["path"] or s["id"]) == "archive" for s in data["streams"]
    ):
        raise ApiError(
            422,
            "invalid",
            "The combined archive needs /archive/; change the conflicting stream id or path first.",
        )


def checked_settings(data):
    # Validate the isolated record without inheriting any unrelated site fields.
    from server.spec.models import SiteData

    if not isinstance(data, dict) or set(data) != {"streams", "sections", "archive"}:
        raise ValueError("stream settings shape")
    value = SiteData.model_validate(data).data()
    return {k: value[k] for k in ("streams", "sections", "archive")}


async def stream_data(db, version, live):
    try:
        row = await db.fetchrow(
            "SELECT settings, approved FROM site_stream_settings WHERE version = $1", version
        )
    except asyncpg.UndefinedTableError:
        return {}
    if not row or (live and not row["approved"]):
        return {}
    try:
        return checked_settings(json.loads(row["settings"]))
    except (ValueError, TypeError, ValidationError):
        raise ApiError(422, "invalid", "Stored stream settings do not validate.") from None


async def stream_write(db, version, data):
    from server.spec.models import SiteData

    normalized = SiteData.model_validate(
        {k: data[k] for k in ("streams", "sections", "archive") if k in data}
    ).data()
    settings = checked_settings({k: normalized[k] for k in ("streams", "sections", "archive")})
    check_stream_settings(settings)
    await db.execute(
        "INSERT INTO site_stream_settings (version,settings) VALUES ($1,$2) ON CONFLICT (version) DO UPDATE SET settings=excluded.settings,approved=0",
        version,
        dumps(settings),
    )


async def stream_approval(db, version):
    await db.execute(
        "UPDATE site_stream_settings SET approved=1 WHERE version=$1 AND EXISTS (SELECT 1 FROM live WHERE item_id='site' AND version=$1)",
        version,
    )
