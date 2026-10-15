"""Versioned site extension. Legacy item JSON stays readable on rollback."""

import json

import asyncpg

from server.spec.embed_url import embed_sources

from .db import dumps, transaction
from .errors import ApiError


def stored_data(kind, data):
    return {k: v for k, v in data.items() if k != "embed_sources"} if kind == "site" else data


async def source_data(db, id, version, data, live=False):
    if id != "site":
        return data
    try:
        row = await db.fetchrow(
            "SELECT sources, approved FROM site_embed_sources WHERE version = $1", version
        )
    except asyncpg.UndefinedTableError:
        return {**data, "embed_sources": []}
    sources = (
        (json.loads(row["sources"]) if not live or row["approved"] else [])
        if row
        else data.get("embed_sources", [])
    )
    return {**data, "embed_sources": sources}


async def source_approval(db, version):
    await db.execute(
        "UPDATE site_embed_sources SET approved = 1 WHERE version = $1"
        " AND EXISTS (SELECT 1 FROM live WHERE item_id = 'site' AND version = $1)",
        version,
    )


async def migrate_sources(db):
    """Repair representation only, preserving versions and the live boundary."""
    async with transaction(db) as c:
        rows = await c.fetch(
            "SELECT version,data,0 AS approved FROM items WHERE id = 'site' AND data::jsonb ? 'embed_sources'"
            " UNION ALL SELECT version,data,0 FROM revisions WHERE item_id = 'site' AND data::jsonb ? 'embed_sources'"
            " UNION ALL SELECT version,data,1 FROM live WHERE item_id = 'site' AND data::jsonb ? 'embed_sources'"
        )
        if not rows:
            return
        versions = {}
        for row in rows:
            sources = dumps(embed_sources(json.loads(row["data"])["embed_sources"]))
            old = versions.get(row["version"])
            if old is None:
                old = await c.fetchrow(
                    "SELECT sources,approved FROM site_embed_sources WHERE version = $1",
                    row["version"],
                )
            if old and old["sources"] != sources:
                raise ApiError(
                    409, "source_conflict", "Stored embed sources disagree for one site version."
                )
            versions[row["version"]] = dict(
                sources=sources, approved=max(old["approved"] if old else 0, row["approved"])
            )
        for version, row in versions.items():
            await c.execute(
                "INSERT INTO site_embed_sources (version,sources,approved) VALUES ($1,$2,$3) ON CONFLICT (version) DO NOTHING",
                version,
                row["sources"],
                row["approved"],
            )
            if row["approved"]:
                await source_approval(c, version)
        for table, key in [("items", "id"), ("revisions", "item_id"), ("live", "item_id")]:
            await c.execute(
                f"UPDATE {table} SET data = (data::jsonb - 'embed_sources')::text WHERE {key} = 'site' AND data::jsonb ? 'embed_sources'"
            )
