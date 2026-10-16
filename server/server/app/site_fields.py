"""Exact-version logical fields; old bundles never read this table."""

import json

import asyncpg


async def broker_data(db, version, live):
    try:
        row = await db.fetchrow(
            "SELECT value, approved FROM site_fields WHERE version = $1 AND key = 'broker'", version
        )
    except asyncpg.UndefinedTableError:
        return ""
    return json.loads(row["value"]) if row and (not live or row["approved"]) else ""


async def fields_approval(db, version):
    await db.execute(
        "UPDATE site_fields SET approved = 1 WHERE version = $1 AND EXISTS (SELECT 1 FROM live WHERE item_id = 'site' AND version = $1)",
        version,
    )

    await db.execute("INSERT INTO private_approvals (version) SELECT f.version FROM site_fields f JOIN live l ON l.version = f.version AND l.item_id = 'site' WHERE f.version = $1 AND f.key = 'private' AND f.approved = 1 ON CONFLICT DO NOTHING",version)


async def private_data(db, version, live):
    row = await db.fetchrow("SELECT value,approved FROM site_fields WHERE version = $1 AND key = 'private'",version)
    return bool(row and json.loads(row["value"]) is True and (not live or (row["approved"] and await db.fetchrow("SELECT 1 FROM private_approvals WHERE version = $1",version))))
