#!/usr/bin/env python3
"""Write real MCP tool answers on deterministic sample-site databases.

tool_parity.py OUTDIR LOOK...; requires PORCHSITE_TEST_DSN. The database is
disposable, named for this run, and dropped after its pool closes.
PORCHSITE_PARITY_MUTATION=legacy-url replays the missing URL normalization
from the historical server-only defect, for the parity check's self-test.
"""

import asyncio
import json
import os
import secrets
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

import asyncpg

from server.app import check, content, mcp, site, themes
from server.app.db import apply_schema

ROOT = Path(__file__).resolve().parents[2]


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


async def main(output, names):
    admin_dsn = os.environ["PORCHSITE_TEST_DSN"]
    parts = urlsplit(admin_dsn)
    name = f"porchsite_parity_{secrets.token_hex(4)}"
    dsn = urlunsplit((parts.scheme, parts.netloc, f"/{name}", parts.query, ""))
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    cases = [{"name": n, "theme": n, "sample": json.loads((ROOT / "themes" / n / "sample.json").read_text())} for n in names]
    cases += json.loads((ROOT / "spec" / "tool-parity-cases.json").read_text())
    fixed = datetime.fromisoformat(os.environ.get("NOW", "2026-10-15T15:30:00Z").replace("Z", "+00:00"))
    proposed = site.proposed_view

    async def fixed_view(*args, **kwargs):
        view = await proposed(*args, **kwargs)
        view.now = fixed
        return view

    site.proposed_view = fixed_view
    mutation = os.environ.get("PORCHSITE_PARITY_MUTATION", "")
    if mutation:
        if mutation != "legacy-url":
            raise ValueError(f"unknown parity mutation {mutation}")
        check._address = lambda href, base: urljoin(base, href)

    admin = await asyncpg.connect(admin_dsn)
    pool = None
    created = False
    try:
        await admin.execute(f'CREATE DATABASE "{name}"')
        created = True
        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
        await apply_schema(pool)
        for case in cases:
            await pool.execute("TRUNCATE items, live, themes")
            theme = case["theme"]
            if "home" in case:
                theme = f'parity-{case["name"]}'
                base = themes.built_in()[case["theme"]]
                look = {**base, "manifest": {**base["manifest"], "name": theme}, "pages": {**base["pages"], "home": case["home"]}}
                await pool.execute("INSERT INTO themes (name, version, package, sha256, installed_at, installed_by, source) VALUES ($1, '1.0.0', $2, 'fixture', $3, 'assistant:test', 'private')", theme, json.dumps(look), "2026-10-10T12:00:00.000Z")
            sample = case["sample"]
            rows = [{"id": "site", "kind": "site", "slug": None, "data": content.validate("site", {**sample["site"], "theme": theme})}]
            rows += [{"id": f"i{i}", "kind": item["kind"], "slug": item.get("slug", f"item-{i}") if item["kind"] == "entry" else None, "data": content.validate(item["kind"], item["data"])} for i, item in enumerate(sample["items"])]
            async with pool.acquire() as conn, conn.transaction():
                for i, row in enumerate(rows):
                    stamp = (datetime(2026, 10, 10, 12) + timedelta(seconds=i)).isoformat(timespec="milliseconds") + "Z"
                    raw = json.dumps(row["data"])
                    await conn.execute("INSERT INTO items (id, kind, slug, version, data, deleted, created_at, updated_at) VALUES ($1, $2, $3, 1, $4, FALSE, $5, $5)", row["id"], row["kind"], row["slug"], raw, stamp)
                    await conn.execute("INSERT INTO live (item_id, kind, slug, version, data, published_at) VALUES ($1, $2, $3, 1, $4, $5)", row["id"], row["kind"], row["slug"], raw, stamp)
            calls = [
                ("site_check", "site_check", {}), ("site_state", "site_state", {}),
                ("site_state_full", "site_state", {"full": True}),
                ("site_state_ids", "site_state", {"ids": ["site", "i0"]}),
                ("site_state_empty", "site_state", {"ids": []}),
                ("site_state_unknown", "site_state", {"ids": ["missing"]}),
            ]
            answers = {}
            for key, tool, args in calls:
                result = await mcp._call(pool, tool, args, {}, "dev")
                answers[key] = {"error": bool(result.is_error), "value": json.loads(result.content[0].text)}
            write_json(output / f'{case["name"]}.json', answers)
        print(f"Server tool parity: {len(names)} samples and {len(cases) - len(names)} regression fixtures")
    finally:
        if pool:
            await pool.close()
        if created:
            await admin.execute(f'DROP DATABASE "{name}"')
        await admin.close()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    asyncio.run(main(sys.argv[1], sys.argv[2:]))
