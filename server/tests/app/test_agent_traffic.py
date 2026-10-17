"""UC9 paired with cloudflare/test/agent-traffic.test.ts."""

import asyncio
import json
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock

import asyncpg
import pytest
import pytest_asyncio
from starlette.requests import Request
from starlette.responses import Response

from server.app import agent_traffic as traffic
from server.app import analytics, content, privacy

from .conftest import TABLES
from .web import publish, signed_in, who

ORIGIN = "https://site.example"
T1 = datetime.fromisoformat("2026-10-18T06:59:00+00:00")
T2 = datetime.fromisoformat("2026-10-18T07:01:00+00:00")
CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "spec/agent-traffic-cases.json").read_text()
)


@pytest_asyncio.fixture(autouse=True)
async def clean(db):
    traffic.reset(db)
    await db.execute(f"TRUNCATE {TABLES} RESTART IDENTITY")
    await db.execute("UPDATE auth_state SET owner_epoch=0,private_floor='' WHERE id=1")


async def fixture(db):
    item = await content.create_item(
        db,
        who,
        "site",
        {
            "title": "Counter fixture",
            "timezone": "America/Los_Angeles",
            "archive": {"enabled": True},
        },
        None,
    )
    entry = await content.create_item(
        db, who, "entry", {"title": "Counted entry", "date": "2026-10-17"}, None
    )
    await publish(db, [item["id"], entry["id"]])
    return item


def request(ua=""):
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("site.example", 443),
            "path": "/",
            "query_string": b"",
            "headers": [(b"user-agent", ua.encode())],
        }
    )


async def test_af_agent_kind_daily_counts(db, http, monkeypatch):
    await fixture(db)
    monkeypatch.setattr(traffic, "utc_now", lambda: T1)
    for ua in [
        "OAI-SearchBot",
        "Claude-SearchBot",
        "Googlebot",
        "GPTBot",
        "ClaudeBot",
        "ChatGPT-User",
        "Claude-User",
    ]:
        assert (await http.get("/", headers={"User-Agent": ua})).status_code == 200
    headers = {"User-Agent": ""}
    robots = await http.get("/robots.txt", headers=headers)
    assert robots.status_code == 200
    assert (await http.head("/robots.txt", headers=headers)).status_code == 200
    assert (
        await http.get("/robots.txt", headers={**headers, "If-None-Match": robots.headers["etag"]})
    ).status_code == 304
    assert (await http.get("/llms.txt", headers={"User-Agent": "OAI-SearchBot"})).status_code == 200
    assert (await http.get("/index.md", headers={"User-Agent": "GPTBot"})).status_code == 200
    response = Response("", headers={"Content-Type": "text/html; charset=utf-8"})
    await asyncio.gather(
        *(traffic.observe(db, request("Claude-User"), response, T1) for _ in range(24))
    )
    await traffic.observe(db, request(), response, T2)
    report = await traffic.traffic_report(db, "2026-10-17", "2026-10-18")
    assert report["daily"] == [
        {"day": "2026-10-17", "kind": "search", "requests": 4},
        {"day": "2026-10-17", "kind": "training", "requests": 3},
        {"day": "2026-10-17", "kind": "user", "requests": 26},
        {"day": "2026-10-17", "kind": "other", "requests": 1},
        {"day": "2026-10-18", "kind": "other", "requests": 1},
    ]
    assert [r["requests"] for r in report["totals"]] == [4, 3, 26, 2]


async def test_af_agent_kind_no_identifiers(db, http):
    await fixture(db)
    columns = await db.fetch(
        "SELECT column_name FROM information_schema.columns WHERE table_name='agent_traffic_daily' ORDER BY ordinal_position"
    )
    assert [r["column_name"] for r in columns] == ["day", "kind", "requests"]
    keys = await db.fetch(
        "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='agent_traffic_daily'::regclass AND i.indisprimary ORDER BY a.attnum"
    )
    assert [r["attname"] for r in keys] == ["day", "kind"]
    await http.get(
        "/?request=not-stored",
        headers={
            "User-Agent": "GPTBot/1.0 marker-not-stored",
            "Referer": "https://example.com/secret",
            "CF-Connecting-IP": "192.0.2.71",
            "X-Request-Id": "not-stored-id",
        },
    )
    await traffic.settle(db)
    rows = [dict(r) for r in await db.fetch("SELECT * FROM agent_traffic_daily")]
    assert len(rows) == 1 and rows[0]["kind"] == "training" and rows[0]["requests"] == 1
    encoded = json.dumps(rows)
    for secret in ["GPTBot", "192.0", "not-stored", "secret", "request_id"]:
        assert secret not in encoded
    for table in ["pageviews", "analytics_daily", "analytics_salts"]:
        assert await db.fetchval(f"SELECT count(*) FROM {table}") == 0

    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute("INSERT INTO agent_traffic_daily VALUES ('2026-10-17','unknown',1)")
    with pytest.raises(asyncpg.CheckViolationError):
        await db.execute("INSERT INTO agent_traffic_daily VALUES ('2026-10-17','other',-1)")


async def test_af_agent_kind_owner_only(db, http):
    item = await fixture(db)
    cookies = await signed_in(db)
    await http.get("/", headers={"User-Agent": "GPTBot"})
    await traffic.settle(db)
    before = await db.fetchval("SELECT SUM(requests) FROM agent_traffic_daily")
    for cookie in [
        "; ".join(f"{k}={v}" for k, v in cookies.items()),
        "__Host-sk_reader=invalid",
        "__Host-sk_owner=expired",
    ]:
        assert (await http.get("/", headers={"Cookie": cookie})).status_code == 200
    await http.get("/", headers={"Authorization": "Bearer invalid"})
    report = await http.get("/review/stats", cookies=cookies)
    assert report.status_code == 200 and "Requests by agent kind" in report.text
    assert "no-store" in report.headers["cache-control"]
    denied = await http.get("/review/stats")
    assert denied.status_code != 200 and "Requests by agent kind" not in denied.text
    assert await db.fetchval("SELECT SUM(requests) FROM agent_traffic_daily") == before
    for path in ["/", "/index.md", "/llms.txt", "/sitemap.xml"]:
        assert "Requests by agent kind" not in (await http.get(path)).text
    await content.update_item(db, who, item["id"], item["version"], {"private": True})
    await publish(db, [item["id"]])
    await traffic.settle(db)
    before = await db.fetchval("SELECT SUM(requests) FROM agent_traffic_daily")
    for path in [
        "/",
        "/index.md",
        "/llms.txt",
        "/robots.txt",
        "/journal/feed.xml",
        "/sitemap.xml",
        "/archive/",
    ]:
        for method in ["GET", "HEAD"]:
            response = await http.request(method, path)
            assert response.status_code == (200 if path == "/robots.txt" else 404)
            if path == "/" and method == "GET":
                assert response.text == privacy.SIGN_IN
    assert (await http.get("/review/stats", cookies=cookies)).status_code == 200
    assert await db.fetchval("SELECT SUM(requests) FROM agent_traffic_daily") == before


async def test_af_agent_kind_parity_rollback(db):
    await fixture(db)
    for case in CASES["agents"]:
        assert traffic.agent_kind(case["ua"]) == case["kind"]
    assert traffic.agent_kind("x" * 4097 + " GPTBot") == "other"
    for row in CASES["rows"]:
        await db.execute(
            "INSERT INTO agent_traffic_daily VALUES ($1,$2,$3)",
            row["day"],
            row["kind"],
            row["requests"],
        )
    result = await analytics.stats(db, days=2, now=T1, content_id="not-an-item", src="campaign")
    assert (
        result["agent_traffic"]["daily"]
        == traffic.format_traffic(CASES["rows"], "2026-10-16", "2026-10-17")["daily"]
    )
    assert "Whole site" in result["agent_traffic"]["scope"]


async def test_excludes_failures_protocol_capability_paths_and_other_representations(db, http):
    await fixture(db)
    for path in [
        "/missing/",
        "/setup",
        "/login",
        "/static/a.js",
        "/manifest.webmanifest",
        "/journal/search.json",
        "/media/00000000000000000000000000000000.jpg",
    ]:
        await http.get(path)
    await http.post("/")
    await http.get("/", headers={"Accept": "text/markdown;q=0,text/html;q=0"})
    await http.get("/archive/?sort=invalid")
    assert await db.fetchval("SELECT count(*) FROM agent_traffic_daily") == 0


async def test_counter_failures_preserve_public_response(db, http, monkeypatch):
    await fixture(db)
    monkeypatch.setattr(
        traffic, "observe", AsyncMock(side_effect=RuntimeError("counter unavailable"))
    )
    response = await http.get("/")
    assert response.status_code == 200 and "Counter fixture" in response.text


async def test_public_representations_count_get_200_only_excluding_head_and_304(db, http):
    await fixture(db)
    paths = [
        "/",
        "/index.md",
        "/robots.txt",
        "/journal/feed.xml",
        "/sitemap.xml",
        "/llms.txt",
        "/archive/",
        "/archive/index.md",
    ]
    for path in paths:
        headers = {"User-Agent": "OAI-SearchBot"}
        response = await http.get(path, headers=headers)
        assert response.status_code == 200, path
        assert response.headers.get("etag"), path
        assert (await http.head(path, headers=headers)).status_code == 200, path
        assert (
            await http.get(path, headers={**headers, "If-None-Match": response.headers["etag"]})
        ).status_code == 304, path
    report=await traffic.traffic_report(db,"2000-01-01","2099-01-01")
    assert next(r["requests"] for r in report["totals"] if r["kind"]=="search")==len(paths)
    assert await db.fetchval("SELECT count(*) FROM agent_traffic_daily WHERE kind!='search'") == 0


async def test_perf_uc9_buffer(db,monkeypatch):
    await fixture(db)
    response=Response('',headers={'Content-Type':'text/html; charset=utf-8'})
    from .test_agent_map import Count
    counted=Count(db)
    await traffic.observe(counted,request('GPTBot'),response,T1,'UTC')
    await asyncio.gather(*(traffic.observe(counted,request('GPTBot'),response,T1,'UTC') for _ in range(24)))
    assert sum(q.startswith('INSERT INTO agent_traffic_daily') for q in counted.calls)==1
    report=await traffic.traffic_report(counted,'2026-10-01','2026-10-31')
    assert next(r['requests'] for r in report['totals'] if r['kind']=='training')==25
    await traffic.flush(counted,T1.timestamp()*1000+60000)
    assert sum(q.startswith('INSERT INTO agent_traffic_daily') for q in counted.calls)==2
    assert await db.fetchval("SELECT sum(requests) FROM agent_traffic_daily WHERE kind='training'")==25
    traffic.reset(counted)
    original=counted.__getattr__
    async def fail(*args,**kwargs):
        raise RuntimeError('flush unavailable')
    monkeypatch.setattr(counted,'execute',fail,raising=False)
    await traffic.observe(counted,request('GPTBot'),response,T1,'UTC')
    monkeypatch.delattr(counted,'execute')
    await traffic.flush(counted,T1.timestamp()*1000+60000)
    assert await db.fetchval("SELECT sum(requests) FROM agent_traffic_daily WHERE kind='training'")==26
