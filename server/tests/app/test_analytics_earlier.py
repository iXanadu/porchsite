"""Past their 90 days, a day's page views go and its counts stay (SPEC §8).
Port of cloudflare/test/analytics-earlier.test.ts."""

import json
from datetime import UTC, datetime

from server.app import analytics


async def old(db, id, visitor, test=False):
    await db.execute(
        "INSERT INTO pageviews (id, day, visitor, path, kind, ref_bucket, test, engaged_ms, created_at, updated_at)"
        " VALUES ($1, '2026-06-01', $2, '/', 'home', 'direct', $3, 1000, '2026-06-01T12:00:00Z', '2026-06-01T12:00:00Z')",
        id,
        visitor,
        test,
    )


async def test_keeps_a_days_counts_as_its_views_are_deleted_and_reports_them_by_month(db):
    await old(db, "old-view-0001", "a")
    await old(db, "old-view-0002", "a")
    await old(db, "old-view-0003", "b")
    await old(db, "old-view-0004", "c", True)
    now = datetime(2026, 10, 12, 12, tzinfo=UTC)
    ev = {"t": "pv", "id": "new-view-0001", "p": "/", "k": "home"}
    await analytics.collect(db, json.dumps(ev).encode(), ip="192.0.2.10", ua="Mozilla/5.0 (test reader)", notrack=False, host="site.example", now=now)  # fmt: skip
    assert await db.fetchval("SELECT count(*) FROM pageviews WHERE day = '2026-06-01'") == 0
    rows = [
        dict(r)
        for r in await db.fetch("SELECT day, visits, views, engaged_ms FROM analytics_daily")
    ]
    assert rows == [{"day": "2026-06-01", "visits": 2, "views": 3, "engaged_ms": 3000}]
    s = await analytics.stats(db, now=now)
    assert s["earlier"] == [{"month": "2026-06", "visits": 2, "views": 3, "engaged_ms": 3000}]
    assert (await analytics.stats(db, now=now, content_id="ent_aaaa1111"))["earlier"] == []
