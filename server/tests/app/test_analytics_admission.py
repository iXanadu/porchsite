"""Port-matched: cloudflare/test/analytics-admission.test.ts."""
import asyncio
import hashlib
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
    await db.execute("DELETE FROM pageviews; DELETE FROM analytics_visitor_counts; DELETE FROM analytics_salts; DELETE FROM analytics_daily; UPDATE analytics_maintenance SET completed_day = '' WHERE id = 1")

async def seed(db, n):
    visitor = await analytics.visitor_hash(db, DAY, "192.0.2.10", UA)
    await db.executemany("INSERT INTO pageviews (id,day,visitor,path,kind,ref_bucket,created_at,updated_at) VALUES ($1,$2,$3,'/','home','direct',$4,$4)", [(f"seed-view-{i}", DAY, visitor, analytics.iso(AT)) for i in range(n)])

async def test_final_slot_and_heartbeats(db):
    await seed(db, 199)
    results = await asyncio.gather(*(send(db, f"final-slot-{i}", {"w": i % 2}) for i in range(8)))
    assert sum(results) == 1
    assert await db.fetchval("SELECT count(*) FROM pageviews") == 200
    assert await db.fetchval("SELECT views FROM analytics_visitor_counts") == 200
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
    await db.execute("INSERT INTO analytics_visitor_counts(day,visitor,views) VALUES('2026-01-01','old',1) ON CONFLICT DO NOTHING")
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
    for fault_index in range(5):
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

async def test_legacy_reconcile_and_saturated_no_source_scan(db):
    assert await send(db, "counter-first-view")
    visitor = await analytics.visitor_hash(db, DAY, "192.0.2.10", UA)
    await db.executemany("INSERT INTO pageviews (id,day,visitor,path,kind,ref_bucket,created_at,updated_at) SELECT $1,$2,$3,'/','home','direct',$4,$4 WHERE NOT EXISTS (SELECT 1 FROM pageviews WHERE day=$2 AND visitor=$3 LIMIT 1 OFFSET 199)", [(f"legacy-view-{i}", DAY, visitor, analytics.iso(AT)) for i in range(199)])
    assert await db.fetchval("SELECT views FROM analytics_visitor_counts") == 1
    assert not await send(db, "reconciled-denial")
    assert await db.fetchval("SELECT count(*) FROM pageviews") == 200
    assert await db.fetchval("SELECT views FROM analytics_visitor_counts") == 200
    class Guarded:
        counter_reads = 0
        forbidden = 0
        def __getattr__(self, name):
            if name in ("transaction", "acquire", "execute", "fetch"):
                self.forbidden += 1
            return getattr(db, name)
        async def fetchrow(self, sql, *args):
            if "FROM pageviews" in sql:
                self.forbidden += 1
                raise AssertionError("source scan on saturated path")
            if sql.startswith("SELECT c.views"):
                self.counter_reads += 1
            return await db.fetchrow(sql, *args)
    guarded = Guarded()
    assert not await send(guarded, "cheap-denial")
    assert guarded.counter_reads == 1
    assert guarded.forbidden == 0

async def test_duplicate_does_not_allocate_another_key(db):
    assert await send(db, "duplicate-counter-view")
    assert not await analytics.collect(db, b'{"t":"pv","id":"duplicate-counter-view","p":"/"}', ip="192.0.2.11", ua=UA, notrack=False, host="site.example", now=AT)
    assert [dict(r) for r in await db.fetch("SELECT views FROM analytics_visitor_counts")] == [dict(views=1)]
    assert await db.fetchval("SELECT count(*) FROM pageviews") == 1

async def test_admission_faults_rollback_counter_and_view(db, monkeypatch):
    await seed(db, 1)
    await db.execute("UPDATE analytics_maintenance SET completed_day=$1 WHERE id=1", DAY)
    original = analytics.transaction
    for index in range(3):
        @asynccontextmanager
        async def faulty(pool):
            async with original(pool) as c:
                class Fault:
                    n = 0
                    def __getattr__(self, name):
                        return getattr(c, name)
                    async def execute(self, sql, *args):
                        if "pg_advisory_xact_lock" not in sql:
                            current = self.n
                            self.n += 1
                            if current == index:
                                raise RuntimeError("injected admission fault")
                        return await c.execute(sql, *args)
                yield Fault()
        monkeypatch.setattr(analytics, "transaction", faulty)
        assert not await send(db, f"counter-rollback-{index}")
        assert await db.fetchval("SELECT count(*) FROM pageviews") == 1
        assert await db.fetchval("SELECT count(*) FROM analytics_visitor_counts") == 0
    monkeypatch.setattr(analytics, "transaction", original)

async def test_retired_counter_uses_original_cap(db):
    await seed(db, 200)
    assert not await send(db, "set-saturation-counter")
    await db.execute("DELETE FROM pageviews")
    await db.execute("UPDATE analytics_maintenance SET completed_day='2027-03-01' WHERE id=1")
    assert await send(db, "retired-fallback-view")
    assert await db.fetchval("SELECT count(*) FROM pageviews") == 1
    assert await db.fetchval("SELECT views FROM analytics_visitor_counts") == 200

async def test_missing_counter_schema_original_cap_and_cleanup(db):
    await seed(db, 199)
    await db.execute("ALTER TABLE analytics_visitor_counts RENAME TO saved_visitor_counts")
    try:
        assert await send(db, "old-schema-final-slot")
        assert not await send(db, "old-schema-denied")
        assert await db.fetchval("SELECT count(*) FROM pageviews") == 200
    finally:
        await db.execute("ALTER TABLE saved_visitor_counts RENAME TO analytics_visitor_counts")

async def test_legacy_and_new_share_final_slot(db):
    await seed(db, 199)
    visitor = await analytics.visitor_hash(db, DAY, "192.0.2.10", UA)
    lock = int.from_bytes(hashlib.sha256(f"AN-1\0{DAY}\0{visitor}".encode()).digest()[:8], "big", signed=True)
    async def legacy():
        async with analytics.transaction(db) as c:
            await c.execute("SELECT pg_advisory_xact_lock($1)", lock)
            status = await c.execute("INSERT INTO pageviews(id,day,visitor,path,kind,ref_bucket,created_at,updated_at) SELECT 'legacy-final-slot',$1,$2,'/','home','direct',$3,$3 WHERE NOT EXISTS (SELECT 1 FROM pageviews WHERE day=$1 AND visitor=$2 LIMIT 1 OFFSET 199) ON CONFLICT(id) DO NOTHING", DAY, visitor, analytics.iso(AT))
            return status.endswith(" 1")
    results = await asyncio.gather(legacy(), *(send(db, f"mixed-final-{i}") for i in range(7)))
    assert sum(results) == 1
    assert await db.fetchval("SELECT count(*) FROM pageviews") == 200
    assert not await send(db, "mixed-final-denial")
    assert await db.fetchval("SELECT views FROM analytics_visitor_counts") == 200
