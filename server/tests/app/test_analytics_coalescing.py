"""Port-matched: cloudflare/test/analytics-coalescing.test.ts."""

import asyncio
import json
from datetime import datetime, timedelta

from server.app import analytics

START = datetime.fromisoformat("2026-10-15T23:59:45+00:00")


async def send(db, ev, ms=0):
    return await analytics.collect(
        db,
        json.dumps(ev).encode(),
        ip="192.0.2.10",
        ua="Mozilla/5.0 (reader)",
        notrack=False,
        host="site.example",
        now=START + timedelta(milliseconds=ms),
    )


async def pv(db, id):
    return await send(db, dict(t="pv", id=id, p="/journal/entry/", k="entry"))


async def row(db, id):
    return dict(
        await db.fetchrow(
            "SELECT engaged_ms, max_scroll, updated_at, day FROM pageviews WHERE id = $1", id
        )
    )


class Observed:
    def __init__(self, conn, writes, barrier=None):
        self.conn, self.writes, self.barrier = conn, writes, barrier

    def __getattr__(self, name):
        return getattr(self.conn, name)

    async def execute(self, sql, *args):
        result = await self.conn.execute(sql, *args)
        if sql.startswith("UPDATE pageviews"):
            self.writes.append(int(result.rsplit(" ", 1)[1]))
        return result

    async def fetchrow(self, sql, *args):
        result = await self.conn.fetchrow(sql, *args)
        if self.barrier and sql.startswith("SELECT created_at"):
            await self.barrier.wait()
        return result


async def test_accepts_duplicate_out_of_order_without_write_and_keeps_original_day(db):
    id = "coalesce-view-0001"
    await pv(db, id)
    writes = []
    async with db.acquire() as conn:
        measured = Observed(conn, writes)
        for e, d, ms in [
            (30000, 50, 40000),
            (30000, 50, 41000),
            (10000, 25, 42000),
            (10000, 100, 43000),
        ]:
            assert await send(measured, dict(t="hb", id=id, e=e, d=d), ms)
        assert writes == [1, 0, 0, 1]
        assert await row(conn, id) == dict(
            engaged_ms=30000,
            max_scroll=100,
            day="2026-10-15",
            updated_at="2026-10-16T00:00:28.000Z",
        )
        assert await send(measured, dict(t="hb", id=id, e=30000, d=100), 44000)
        assert (await row(conn, id))["updated_at"] == "2026-10-16T00:00:28.000Z"


async def test_merges_concurrent_maxima_when_both_reads_have_the_old_snapshot(db):
    id = "coalesce-race-0001"
    await pv(db, id)
    writes, barrier = [], asyncio.Barrier(2)
    async with db.acquire() as first, db.acquire() as second:
        assert await asyncio.gather(
            send(Observed(first, writes, barrier), dict(t="hb", id=id, e=40000, d=25), 45000),
            send(Observed(second, writes, barrier), dict(t="hb", id=id, e=10000, d=100), 45000),
        ) == [True, True]
    result = await row(db, id)
    assert (result["engaged_ms"], result["max_scroll"]) == (40000, 100)
    assert writes == [1, 1]


async def test_retains_wall_time_four_hour_engagement_and_six_hour_acceptance(db):
    id = "coalesce-limits-01"
    await pv(db, id)
    assert await send(db, dict(t="hb", id=id, e=99_000_000, d=200), 10000)
    result = await row(db, id)
    assert (result["engaged_ms"], result["max_scroll"]) == (15000, 100)
    assert await send(db, dict(t="hb", id=id, e=99_000_000, d=200), 5 * 3600_000)
    result = await row(db, id)
    assert (result["engaged_ms"], result["max_scroll"]) == (4 * 3600_000, 100)
    assert not await send(db, dict(t="hb", id=id, e=1), 6 * 3600_000)


async def test_same_final_snapshots_keep_reports_and_missing_final_is_not_estimated(db):
    async def report(frequent, final=True):
        await db.execute("DELETE FROM pageviews")
        for n, extra in [(1, dict(s="x", q="post-1", c="ent_aaaa1111")), (2, dict(w=1)), (3, {})]:
            id = f"coalesce-report-{n}"
            await send(
                db,
                dict(
                    t="pv",
                    id=id,
                    p="/" if n == 3 else "/journal/entry/",
                    k="home" if n == 3 else "entry",
                    **extra,
                ),
            )
            for seconds in [15, 30, 45, 60] if frequent else [30, 60] if final else [30]:
                await send(
                    db,
                    dict(t="hb", id=id, e=seconds * 1000, d=100 if seconds == 60 else 25),
                    seconds * 1000,
                )
        return [
            await analytics.stats(db, now=START + timedelta(hours=1), **filter)
            for filter in [
                {},
                dict(src="x"),
                dict(post="post-1"),
                dict(content_id="ent_aaaa1111"),
                dict(include_test=True),
            ]
        ]

    before, after = await report(True), await report(False)
    assert after == before
    assert after[0]["totals"]["views"] == 2
    assert after[4]["totals"]["views"] == 3
    lost = await report(False, False)
    assert lost[0]["totals"]["engaged_ms"] < after[0]["totals"]["engaged_ms"]
    assert (
        "Time on page and scroll can lag up to a minute while someone is still reading."
        in lost[0]["notes"]
    )
    assert (
        "If the final message is lost, recorded time and scroll can be lower." in lost[0]["notes"]
    )


async def test_live_timezone_and_heartbeat_across_midnight(db):
    await db.execute(
        "INSERT INTO live (item_id,kind,version,data,published_at)"
        " VALUES ('site','site',1,$1,'2026-10-15')",
        json.dumps(dict(timezone="America/Los_Angeles")),
    )
    try:
        now = datetime.fromisoformat("2026-10-16T06:59:45+00:00")

        async def put(ev, ms):
            return await analytics.collect(
                db,
                json.dumps(ev).encode(),
                ip="192.0.2.10",
                ua="Mozilla/5.0 (reader)",
                notrack=False,
                host="site.example",
                now=now + timedelta(milliseconds=ms),
            )

        await put(dict(t="pv", id="coalesce-tz-00001", p="/"), 0)
        await put(dict(t="hb", id="coalesce-tz-00001", e=45000, d=50), 45000)
        await put(dict(t="pv", id="coalesce-tz-00002", p="/"), 46000)
        first = await row(db, "coalesce-tz-00001")
        assert (first["day"], first["engaged_ms"]) == ("2026-10-15", 45000)
        assert (await row(db, "coalesce-tz-00002"))["day"] == "2026-10-16"
        assert [
            r["day"] for r in await db.fetch("SELECT day FROM analytics_salts ORDER BY day")
        ] == ["2026-10-16"]
    finally:
        await db.execute("DELETE FROM live WHERE item_id = 'site'")
