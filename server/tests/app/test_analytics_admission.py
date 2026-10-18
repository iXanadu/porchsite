"""Port-matched: cloudflare/test/analytics-admission.test.ts."""
import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

import pytest_asyncio
from server.app import analytics

AT = datetime.fromisoformat("2026-10-18T12:00:00+00:00")
DAY = "2026-10-18"
UA = "Mozilla/5.0 reader"

async def send(db, id, extra=None, now=AT):
    return await analytics.collect(db, json.dumps({**dict(t="pv", id=id, p="/"), **(extra or {})}).encode(), ip="192.0.2.10", ua=UA, notrack=False, host="site.example", now=now)

@pytest_asyncio.fixture(autouse=True)
async def clear(db):
    await db.execute("DELETE FROM pageviews; DELETE FROM analytics_salts; DELETE FROM analytics_daily; UPDATE analytics_maintenance SET completed_day = '' WHERE id = 1")

async def seed(db, n):
    visitor = await analytics.visitor_hash(db, DAY, "192.0.2.10", UA)
    await db.executemany("INSERT INTO pageviews (id,day,visitor,path,kind,ref_bucket,created_at,updated_at) VALUES ($1,$2,$3,'/','home','direct',$4,$4)", [(f"seed-view-{i}", DAY, visitor, analytics.iso(AT)) for i in range(n)])

async def test_final_slot_and_heartbeats(db):
    await seed(db, 199)
    results = await asyncio.gather(*(send(db, f"final-slot-{i}", {"w": i % 2}) for i in range(8)))
    assert sum(results) == 1
    assert await db.fetchval("SELECT count(*) FROM pageviews") == 200
    winner, loser = results.index(True), results.index(False)
    assert not await send(db, f"final-slot-{winner}")
    assert not await send(db, "above-cap-view", {"day": "2099-01-01", "visitor": "fake", "cap": 999})
    assert await send(db, f"final-slot-{winner}", {"t": "hb", "e": 1000, "d": 25}, AT + timedelta(seconds=10))
    assert not await send(db, f"final-slot-{loser}", {"t": "hb", "e": 1000})
    assert "At most 200 page views per visitor per day are recorded; additional page views are omitted." in (await analytics.stats(db, now=AT))["notes"]

async def test_historical_rows_and_new_day(db):
    await seed(db, 201)
    assert not await send(db, "old-history-new")
    assert await db.fetchval("SELECT count(*) FROM pageviews") == 201
    assert await send(db, "next-day-new", now=AT + timedelta(days=1))
    assert await db.fetchval("SELECT count(*) FROM pageviews") == 202

async def test_invalid_inputs_no_database_work(db):
    class Forbidden:
        calls = 0
        def __getattr__(self, name):
            self.calls += 1
            raise RuntimeError("unexpected database use")
    fail = Forbidden()
    assert not await send(fail, "short")
    assert not await send(fail, "excluded-path", {"p": "/review/"})
    for opts in [dict(notrack=True, ua=UA), dict(notrack=False, ua="bot")]:
        assert not await analytics.collect(fail, b'{"t":"pv","id":"valid-id-01","p":"/"}', ip="192.0.2.10", host="site.example", **opts)
    assert not await analytics.collect(fail, b"{", ip="", ua=UA, notrack=False, host="site.example")
    assert fail.calls == 0

async def expired(db):
    await db.execute("INSERT INTO pageviews (id,day,visitor,path,kind,ref_bucket,engaged_ms,created_at,updated_at) VALUES ('expired-view','2026-01-01','old','/','home','direct',1000,'2026-01-01','2026-01-01')")

async def test_cleanup_concurrency_counts_and_watermark(db):
    await expired(db)
    assert all(await asyncio.gather(*(send(db, f"cleanup-race-{i}") for i in range(8))))
    assert [dict(r) for r in await db.fetch("SELECT * FROM analytics_daily")] == [dict(day="2026-01-01", visits=1, views=1, engaged_ms=1000)]
    await expired(db)
    await send(db, "same-day-view")
    assert await db.fetchval("SELECT id FROM pageviews WHERE id='expired-view'") == "expired-view"
    await send(db, "backwards-view", now=AT - timedelta(days=1))
    assert await db.fetchval("SELECT completed_day FROM analytics_maintenance WHERE id=1") == DAY
    await send(db, "later-day-view", now=AT + timedelta(days=1))
    assert await db.fetchval("SELECT id FROM pageviews WHERE id='expired-view'") is None

async def test_cleanup_fault_rollback_and_no_fail_open(db, monkeypatch):
    original = analytics.transaction
    for fault_index in range(4):
        await db.execute("DELETE FROM pageviews")
        await expired(db)
        @asynccontextmanager
        async def faulty(pool):
            async with original(pool) as c:
                class Fault:
                    n = 0
                    def __getattr__(self, name):
                        return getattr(c, name)
                    async def execute(self, sql, *args):
                        n = self.n
                        self.n += 1
                        if n == fault_index:
                            raise RuntimeError("injected cleanup fault")
                        return await c.execute(sql, *args)
                yield Fault()
        monkeypatch.setattr(analytics, "transaction", faulty)
        assert not await send(db, f"failed-cleanup-{fault_index}")
        assert await db.fetchval("SELECT count(*) FROM pageviews") == 1
        assert await db.fetchval("SELECT completed_day FROM analytics_maintenance WHERE id=1") == ""
        assert await db.fetchval("SELECT count(*) FROM analytics_daily") == 0
    monkeypatch.setattr(analytics, "transaction", original)
