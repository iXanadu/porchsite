"""The safety rules (spec §2), against the real PostgreSQL code paths. Port
of cloudflare/test/rules.test.ts."""

import itertools

import pytest

from server.app import approvals, content, site
from server.app.errors import ApiError

who = "assistant:test"
_n = itertools.count(1)


def entry(**extra):
    return {"title": f"Entry {next(_n)}", "date": "2026-10-08", "summary": "A test entry.", **extra}


async def refused(aw) -> ApiError:
    with pytest.raises(ApiError) as e:
        await aw
    return e.value


async def live_titles(db) -> list[str]:
    """What the home page lists (the built-in look shows every live entry)."""
    return [e["title"] for e in (await site.live_view(db)).entries]


# --- versions, retries, guard, history ---


async def test_refuses_an_update_from_an_old_version(db):
    a = await content.create_item(db, who, "entry", entry(), None)
    await content.update_item(db, who, a["id"], 1, {"summary": "Second."})
    assert (
        await refused(content.update_item(db, who, a["id"], 1, {"summary": "Lost?"}))
    ).code == "version_conflict"
    assert (
        await refused(content.update_item(db, who, a["id"], 0, {"summary": "Zero"}))
    ).code == "version_conflict"
    assert (await content.get_item(db, a["id"]))["data"]["summary"] == "Second."


async def test_returns_the_same_item_for_a_replayed_create(db):
    data = entry()
    a = await content.create_item(db, who, "entry", data, "key-1")
    b = await content.create_item(db, who, "entry", data, "key-1")
    assert b["id"] == a["id"]
    assert b["replayed"] is True
    assert (
        await refused(content.create_item(db, who, "entry", entry(), "key-1"))
    ).code == "idempotency_mismatch"


async def test_refuses_secrets_in_drafts(db):
    e = await refused(
        content.create_item(db, who, "entry", entry(body="password: hunter2xyz"), None)
    )
    assert e.code == "content_guard"


async def test_keeps_every_version_and_rolls_back(db):
    a = await content.create_item(db, who, "entry", entry(), None)
    b = await content.update_item(db, who, a["id"], 1, {"summary": "Changed."})
    c = await content.rollback(db, who, a["id"], 1, b["version"])
    assert c["version"] == 3
    assert c["data"]["summary"] == "A test entry."
    assert [h["action"] for h in await content.history(db, a["id"])] == [
        "rollback",
        "update",
        "create",
    ]


async def test_reads_a_cards_old_status_as_its_badge(db):
    c = await content.create_item(
        db, who, "card", {"name": "Old", "description": "x", "status": "Beta"}, None
    )
    assert c["data"]["badge"] == "Beta"
    assert c["data"]["link"] == ""


# --- the owner's yes (S1, S2) ---


async def test_publishes_exactly_the_approved_items_and_nothing_else(db):
    a = await content.create_item(db, who, "entry", entry(title="Approved one"), None)
    b = await content.create_item(db, who, "entry", entry(title="Left staged"), None)
    req = await approvals.request(db, who, [a["id"]], "test")
    assert "Approved one" not in await live_titles(db)
    await approvals.decide(db, req["id"], {a["id"]: {"decision": "approve"}}, "")
    home = await live_titles(db)
    assert "Approved one" in home
    assert "Left staged" not in home
    assert b["id"]


async def test_voids_the_request_for_an_item_edited_after_asking(db):
    a = await content.create_item(db, who, "entry", entry(title="Edited later"), None)
    req = await approvals.request(db, who, [a["id"]], "")
    await content.update_item(db, who, a["id"], 1, {"summary": "Changed after asking."})
    got = await approvals.get(db, req["id"])
    assert got["items"][0]["status"] == "superseded"
    assert got["status"] == "decided"
    out = await approvals.decide(db, req["id"], {a["id"]: {"decision": "approve"}}, "")
    assert out["published"] == []
    assert "Edited later" not in await live_titles(db)


async def test_refuses_drafts_and_unchanged_items(db):
    d = await content.create_item(db, who, "entry", entry(status="draft"), None)
    assert (await refused(approvals.request(db, who, [d["id"]], ""))).code == "draft"
    a = await content.create_item(db, who, "entry", entry(), None)
    req = await approvals.request(db, who, [a["id"]], "")
    await approvals.decide(db, req["id"], {a["id"]: {"decision": "approve"}}, "")
    assert (await refused(approvals.request(db, who, [a["id"]], ""))).code == "nothing_to_approve"


async def test_a_newer_request_takes_the_item_out_of_an_older_one(db):
    a = await content.create_item(db, who, "entry", entry(), None)
    first = await approvals.request(db, who, [a["id"]], "")
    await approvals.request(db, who, [a["id"]], "again")
    assert (await approvals.get(db, first["id"]))["items"][0]["status"] == "superseded"
