"""Putting the site back to a publish from before the site's text was first
published leaves that text as it is (SPEC §5). Port of
cloudflare/test/revert-site.test.ts."""

from server.app import approvals, content, history

who = "assistant:Helper"


async def publish(db, ids):
    req = await approvals.request(db, who, ids, "")
    await approvals.decide(db, req["id"], {i: {"decision": "approve"} for i in ids}, "")


async def test_leaves_the_site_text_alone_going_back_to_before_it_was_first_published(db):
    a = await content.create_item(db, who, "entry", {"title": "First pot", "date": "2026-10-01"}, None)  # fmt: skip
    await publish(db, [a["id"]])
    first = (await history.publishes(db))[0]["id"]
    s = await content.create_item(db, who, "site", {"title": "Kettle", "tagline": "Tea."}, None)  # fmt: skip
    b = await content.create_item(db, who, "entry", {"title": "Second pot", "date": "2026-10-02"}, None)  # fmt: skip
    await publish(db, [s["id"], b["id"]])
    ids = [c["id"] for c in (await history.plan(db, first))["changes"]]
    assert b["id"] in ids
    assert s["id"] not in ids
