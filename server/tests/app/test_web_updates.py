"""The update notice (SPEC §4 Updates): a daily look at latest.json, kept in
the database, shown in site_state.update and as one quiet line on the owner's
review pages. It never applies anything. Port of cloudflare/test/update.test.ts;
the cases are spec/update-cases.json, shared with it."""

import json
from pathlib import Path

import httpx
import pytest

from server.app import approvals, content, oauth, updates

from .web import Mcp, signed_in, who

CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "update-cases.json").read_text(encoding="utf-8")
)
DAY = updates.DAY_MS
T0 = 1792573200000  # 2026-10-21T09:00:00Z


class Stub:
    def __init__(self):
        self.calls: list[str] = []
        self.answer = lambda: httpx.Response(200, json=CASES["latest"])

    async def __call__(self, url: str) -> httpx.Response:
        self.calls.append(url)
        return self.answer()


@pytest.fixture
async def stub(db):
    s = Stub()
    updates.runtime.fetch = s
    await db.execute("DELETE FROM kv_cache")
    yield s
    del updates.runtime.fetch
    updates.runtime.release = None


def with_how(u):
    return {**u, "how": updates.HOW} if u["available"] else u


@pytest.mark.parametrize("case", CASES["cases"], ids=[c["name"] for c in CASES["cases"]])
async def test_what_a_running_release_lacks(db, stub, case):
    assert await updates.check(db, case["running"], T0) == with_how(case["update"])
    # A build that isn't a published release never asks.
    if not updates.RELEASE_ID.match(case["running"]):
        assert stub.calls == []


async def test_reads_a_latest_json_without_the_release_history(db, stub):
    c = CASES["latest_without_history"]
    stub.answer = lambda: httpx.Response(200, json=c["latest"])
    assert await updates.check(db, c["running"], T0) == with_how(c["update"])


async def test_asks_at_most_once_a_day(db, stub):
    running = "2026.10.15-bbbbbbb"
    assert (await updates.check(db, running, T0))["available"]
    assert (await updates.check(db, running, T0 + DAY - 1))["available"]
    assert stub.calls == [updates.LATEST_URL]
    assert updates.LATEST_URL == "https://get.porchsite.dev/latest.json"
    # A day later it asks again, and hears the site is now current.
    now_current = {
        **CASES["latest"],
        "version": running,
        "releases": CASES["latest"]["releases"][1:],
    }
    stub.answer = lambda: httpx.Response(200, json=now_current)
    assert await updates.check(db, running, T0 + DAY) == {"available": False}
    assert len(stub.calls) == 2


async def test_is_silent_on_failure_keeps_what_it_knew_and_retries_next_day(db, stub):
    running = "2026.10.15-bbbbbbb"

    def offline():
        raise httpx.ConnectError("offline")

    stub.answer = offline
    assert await updates.check(db, running, T0) == {"available": False}
    assert await updates.check(db, running, T0 + 1000) == {"available": False}
    assert len(stub.calls) == 1
    stub.answer = lambda: httpx.Response(200, json=CASES["latest"])
    assert (await updates.check(db, running, T0 + DAY))["available"]
    # A later failure (a 500, or junk) keeps the last answer instead of forgetting it.
    stub.answer = lambda: httpx.Response(500, text="nope")
    assert (await updates.check(db, running, T0 + 2 * DAY))["available"]
    stub.answer = lambda: httpx.Response(200, text="{not json")
    assert (await updates.check(db, running, T0 + 3 * DAY))["available"]
    assert len(stub.calls) == 4


LINE = "A newer Porchsite is available (2026.10.20-ccccccc). Ask your assistant to update it."


async def test_review_pages_show_one_quiet_line(db, http, stub):
    cookies = await signed_in(db)
    updates.runtime.release = "2026.10.20-ccccccc"
    assert "newer Porchsite" not in (await http.get("/review", cookies=cookies)).text
    await db.execute("DELETE FROM kv_cache")
    updates.runtime.release = "2026.10.15-bbbbbbb"
    n = await content.create_item(
        db, who, "note", {"text": "Open today.", "date": "2026-10-07"}, None
    )
    r = await approvals.request(db, who, [n["id"]], "")
    for path in ("/review", f"/review/{r['id']}"):
        html = (await http.get(path, cookies=cookies)).text
        assert f'<p class="meta">{LINE}</p>' in html
        assert "Security update" not in html


async def test_review_pages_mark_a_security_release(db, http, stub):
    updates.runtime.release = "2026.10.12-aaaaaaa"
    html = (await http.get("/review", cookies=await signed_in(db))).text
    assert (
        '<p class="warn"><b>Security update:</b> a newer Porchsite is available (2026.10.20-ccccccc). Ask your assistant to update it.</p>'
        in html
    )
    assert f'<p class="meta">{LINE}</p>' not in html


async def test_review_pages_say_nothing_on_a_dev_build(db, http, stub):
    # The test app runs release "test".
    assert (
        "Porchsite is available"
        not in (await http.get("/review", cookies=await signed_in(db))).text
    )
    assert stub.calls == []


async def test_site_state_carries_update(db, http, stub):
    a = Mcp(http, await oauth.mint(db, "Helper", "https://site.example"))
    updates.runtime.release = "2026.10.12-aaaaaaa"
    err, state, _ = await a.call("site_state")
    assert not err
    assert state["update"] == {
        **CASES["cases"][2]["update"],
        "how": "https://get.porchsite.dev/docs/self-hosting/#updating-the-server-edition",
    }
    updates.runtime.release = None
    err, state, _ = await a.call("site_state")
    assert state["update"] == {"available": False}
