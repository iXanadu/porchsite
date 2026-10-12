"""Visitor analytics (spec §8): first-party, nothing that identifies a person.
Port of cloudflare/test/analytics.test.ts."""

import json
import re
from datetime import UTC, datetime
from pathlib import Path

from server.app import analytics
from server.app.theme import BEACON_JS

from .web import signed_in

UA = "Mozilla/5.0 (test reader)"
D = "2026-10-12"


def at_(hms: str, day: str = D) -> datetime:
    return datetime.fromisoformat(f"{day}T{hms}+00:00")


async def send(db, ev, now, ip="192.0.2.10", ua=UA, notrack=False):
    return await analytics.collect(
        db, json.dumps(ev).encode(), ip=ip, ua=ua, notrack=notrack, host="site.example", now=now
    )


async def test_records_a_page_view_and_its_heartbeats_and_never_the_address(db):
    assert await send(db, {"t": "pv", "id": "view-aaaa-0001", "p": "/", "k": "home", "r": "https://www.google.com/search"}, at_("12:00:00"))  # fmt: skip
    assert await send(
        db, {"t": "hb", "id": "view-aaaa-0001", "e": 30000, "d": 100}, at_("12:00:40")
    )
    row = dict(await db.fetchrow("SELECT * FROM pageviews WHERE id = 'view-aaaa-0001'"))
    assert {k: row[k] for k in ("day", "path", "kind", "ref_bucket", "ref_domain", "engaged_ms", "max_scroll", "test")} == {"day": D, "path": "/", "kind": "home", "ref_bucket": "search", "ref_domain": "google.com", "engaged_ms": 30000, "max_scroll": 100, "test": False}  # fmt: skip
    assert re.fullmatch(r"[0-9a-f]{32}", row["visitor"])
    assert "192.0.2.10" not in json.dumps(row, default=str)
    # A replayed view counts once; engaged time never passes wall time since the view.
    assert not await send(db, {"t": "pv", "id": "view-aaaa-0001", "p": "/", "k": "home"}, at_("12:00:41"))  # fmt: skip
    assert await send(db, {"t": "pv", "id": "view-wall-0001", "p": "/x/"}, at_("12:00:00"))
    assert await send(db, {"t": "hb", "id": "view-wall-0001", "e": 4 * 3600 * 1000, "d": 10}, at_("12:00:10"))  # fmt: skip
    got = await db.fetchrow("SELECT engaged_ms, max_scroll FROM pageviews WHERE id = 'view-wall-0001'")  # fmt: skip
    assert dict(got) == {"engaged_ms": 15000, "max_scroll": 10}
    # Nor after six hours.
    assert not await send(db, {"t": "hb", "id": "view-wall-0001", "e": 1000}, at_("18:00:01"))
    await db.execute("DELETE FROM pageviews WHERE id = 'view-wall-0001'")


async def test_leaves_out_bots_the_owner_owner_pages_and_anything_malformed(db):
    now = at_("12:00:05")
    assert not await send(
        db, {"t": "pv", "id": "view-bot-00001", "p": "/"}, now, ua="Googlebot/2.1"
    )
    assert not await send(db, {"t": "pv", "id": "view-bot-00002", "p": "/"}, now, ua="")
    assert not await send(db, {"t": "pv", "id": "view-own-00001", "p": "/"}, now, notrack=True)
    assert not await send(db, {"t": "pv", "id": "view-rev-00001", "p": "/review/abc"}, now)
    assert not await send(db, {"t": "pv", "id": "short", "p": "/"}, now)
    assert not await send(db, {"t": "pv", "id": "view-big-00001", "p": "/" + "x" * 3000}, now)
    assert not await analytics.collect(db, b"not json", ip="192.0.2.10", ua=UA, notrack=False, host="site.example", now=now)  # fmt: skip
    assert not await send(db, {"t": "hb", "id": "view-none-0001", "e": 1000}, now)
    assert await db.fetchval("SELECT COUNT(*) FROM pageviews") == 1


async def test_makes_one_visitor_per_day_and_forgets_the_days_salt_once_its_over(db):
    await send(db, {"t": "pv", "id": "view-aaaa-0002", "p": "/journal/tea/", "k": "entry", "c": "ent_aaaa1111", "r": "https://site.example/"}, at_("12:01:00"))  # fmt: skip
    await send(db, {"t": "hb", "id": "view-aaaa-0002", "e": 60000, "d": 50}, at_("12:02:30"))
    assert await db.fetchval("SELECT COUNT(DISTINCT visitor) FROM pageviews WHERE day = $1", D) == 1
    row = await db.fetchrow(
        "SELECT prev_path, ref_bucket FROM pageviews WHERE id = 'view-aaaa-0002'"
    )
    assert dict(row) == {"prev_path": "/", "ref_bucket": "internal"}
    await send(db, {"t": "pv", "id": "view-next-0001", "p": "/", "k": "home"}, at_("09:00:00", "2026-10-13"))  # fmt: skip
    days = [r["day"] for r in await db.fetch("SELECT day FROM analytics_salts ORDER BY day")]
    assert days == ["2026-10-13"]
    two = await db.fetch("SELECT visitor FROM pageviews WHERE id IN ('view-aaaa-0002', 'view-next-0001')")  # fmt: skip
    assert len({r["visitor"] for r in two}) == 2
    await db.execute("DELETE FROM pageviews WHERE id = 'view-next-0001'")


async def test_reports_visits_pages_sources_and_tagged_links(db):
    await send(db, {"t": "pv", "id": "view-bbbb-0001", "p": "/journal/tea/", "k": "entry", "c": "ent_aaaa1111", "r": "", "s": "X", "q": "p1"}, at_("12:05:00"), "198.51.100.7")  # fmt: skip
    await send(db, {"t": "hb", "id": "view-bbbb-0001", "e": 5000, "d": 25}, at_("12:05:10"))
    await send(db, {"t": "pv", "id": "view-test-0001", "p": "/", "k": "home", "w": 1}, at_("12:06:00"), "198.51.100.9")  # fmt: skip
    s = await analytics.stats(db, days=7, now=at_("18:00:00"))
    assert s["range"] == {"start": "2026-10-06", "end": D}
    assert s["totals"] == {"visits": 2, "views": 3, "engaged_ms": 95000, "median_visit_engaged_ms": 47500, "bounce_rate": 50, "multi_page_rate": 50}  # fmt: skip
    assert s["daily"] == [{"day": D, "visits": 2, "views": 3, "engaged_ms": 95000}]
    assert s["pages"] == [
        {
            "path": "/journal/tea/",
            "kind": "entry",
            "content_id": "ent_aaaa1111",
            "title": None,
            "readers": 2,
            "views": 2,
            "median_engaged_ms": 32500,
            "mean_engaged_ms": 32500,
            "reached": {"25": 100, "50": 50, "75": 0, "100": 0},
            "landings": 1,
            "bounce_rate": 100,
            "exits": 2,
        },  # fmt: skip
        {
            "path": "/",
            "kind": "home",
            "content_id": None,
            "title": None,
            "readers": 1,
            "views": 1,
            "median_engaged_ms": 30000,
            "mean_engaged_ms": 30000,
            "reached": {"25": 100, "50": 100, "75": 100, "100": 100},
            "landings": 1,
            "bounce_rate": 0,
            "exits": 0,
        },  # fmt: skip
    ]
    assert s["sources"] == [{"source": "search", "visits": 1, "engaged_ms": 90000}, {"source": "x", "visits": 1, "engaged_ms": 5000}]  # fmt: skip
    assert s["referring_domains"] == [{"domain": "google.com", "visits": 1}]
    assert s["tagged"] == [{"src": "x", "post": "p1", "visits": 1, "visit_engaged_ms": 5000}]
    with_test = await analytics.stats(db, days=7, now=at_("18:00:00"), include_test=True)
    assert with_test["totals"]["visits"] == 3
    one = await analytics.stats(db, days=7, now=at_("18:00:00"), src="x")
    assert (one["totals"]["visits"], one["totals"]["views"]) == (1, 1)
    assert one["filter"] == {"content_id": None, "src": "x", "post": None, "include_test": False}
    assert analytics.pct(1, 3) == 33.3
    assert analytics.pct(2, 3) == 66.7
    # Whole numbers as JSON.stringify writes them.
    assert json.dumps(s["totals"]["bounce_rate"]) == "50"


async def test_serves_the_beacon_from_the_kit_and_takes_its_events_at_collect(db, http):
    js = await http.get("/static/a.js")
    assert js.headers["content-type"] == "text/javascript; charset=utf-8"
    assert js.text == BEACON_JS
    assert 'navigator.sendBeacon("/collect"' in js.text
    # The same bytes as the Cloudflare edition's beacon.
    ts = (Path(__file__).parents[3] / "cloudflare" / "src" / "beacon.ts").read_text(
        encoding="utf-8"
    )
    assert ts[ts.index("`") + 1 : ts.rindex("`")] == BEACON_JS
    body = json.dumps({"t": "pv", "id": "view-http-0001", "p": "/", "k": "home"})
    r = await http.post("/collect", content=body, headers={"user-agent": UA, "x-forwarded-for": "192.0.2.20"})  # fmt: skip
    assert r.status_code == 204
    assert await db.fetchval("SELECT 1 FROM pageviews WHERE id = 'view-http-0001'") == 1
    owner = await http.post("/collect", content=body.replace("0001", "0002"), headers={"user-agent": UA}, cookies={"sk_nt": "1"})  # fmt: skip
    assert owner.status_code == 204
    assert await db.fetchrow("SELECT 1 FROM pageviews WHERE id = 'view-http-0002'") is None


async def test_shows_the_owner_the_numbers_and_leaves_their_browser_out(db, http):
    await db.execute("DELETE FROM pageviews WHERE id = 'view-http-0001'")
    await db.execute("UPDATE pageviews SET day = $1 WHERE day = $2", analytics.local_day(datetime.now(UTC), "UTC"), D)  # fmt: skip
    cookies = await signed_in(db)
    page = await http.get("/review/stats?days=7", cookies=cookies)
    assert analytics.NOTRACK_SET in page.headers.get_list("set-cookie")
    text = page.text
    for part in [
        "<h1>Who's reading</h1>",
        '<a class="range on" href="/review/stats?days=7">7 days</a>',
        '<div class="stat"><b>2</b><span>visitors</span></div>',
        '<div class="stat"><b>3</b><span>pages read</span></div>',
        '<div class="stat"><b>48s</b><span>typical stay</span></div>',
        '<div class="stat"><b>50%</b><span>left right away</span></div>',
        '<div class="meta">entry · /journal/tea/</div>',
        "<span>2 readers</span><span>typical 33s</span><span>avg 33s</span><span>100% left right away</span>",
        '<span class="drop-num">50%</span>',
        "<span>Search</span><span>1 · 1m 30s</span>",
        '<div class="row sub-row"><span>google.com</span><span>1</span></div>',
        "<span>x · p1</span><span>1 · 5s</span>",
    ]:
        assert part in text, part
    assert (await http.get("/review/stats")).status_code == 303
    assert (
        analytics.NOTRACK_SET
        == "sk_nt=1; Path=/collect; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000"
    )
