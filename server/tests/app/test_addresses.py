"""Entry addresses (SPEC §3): dateless streams, a chosen slug, and old
addresses that redirect. Port of cloudflare/test/addresses.test.ts."""

import json

import pytest

from server.app import approvals, content
from server.app.errors import ApiError

from .web import signed_in

who = "assistant:Helper"


async def publish(db, ids):
    req = await approvals.request(db, who, ids, "")
    await approvals.decide(db, req["id"], {i: {"decision": "approve"} for i in ids}, "")


async def refused(aw) -> ApiError:
    with pytest.raises(ApiError) as e:
        await aw
    return e.value


async def test_a_dateless_stream_gives_new_entries_their_title_words_alone(db, http):
    s = await content.create_item(db, who, "site", {"title": "Docs", "streams": [{"id": "journal", "title": "Log"}, {"id": "guide", "title": "Guide", "dated_addresses": False}]}, None)  # fmt: skip
    assert [x["dated_addresses"] for x in s["data"]["streams"]] == [True, False]
    a = await content.create_item(db, who, "entry", {"stream": "guide", "title": "How it works", "date": "2026-10-09"}, None)  # fmt: skip
    assert a["slug"] == "how-it-works"
    b = await content.create_item(db, who, "entry", {"stream": "journal", "title": "How it works", "date": "2026-10-09"}, None)  # fmt: skip
    assert b["slug"] == "2026-10-09-how-it-works"
    await publish(db, [s["id"], a["id"], b["id"]])
    assert (await http.get("/guide/how-it-works/")).status_code == 200


async def test_takes_a_chosen_slug_on_create_and_keeps_it_out_of_the_data(db):
    a = await content.create_item(db, who, "entry", {"title": "Prices for 2026", "date": "2026-10-09", "slug": "prices"}, None)  # fmt: skip
    assert a["slug"] == "prices"
    assert "slug" not in a["data"]
    bad = await refused(content.create_item(db, who, "entry", {"title": "Bad", "date": "2026-10-09", "slug": "Not OK"}, None))  # fmt: skip
    assert bad.code == "invalid"
    assert '"field":"slug"' in json.dumps(bad.extra, separators=(",", ":"))


async def test_refuses_a_slug_another_entry_has(db):
    await content.create_item(db, who, "entry", {"title": "Contact", "date": "2026-10-09", "slug": "contact"}, None)  # fmt: skip
    b = await content.create_item(db, who, "entry", {"title": "Reach us", "date": "2026-10-09"}, None)  # fmt: skip
    err = await refused(content.update_item(db, who, b["id"], b["version"], {"slug": "contact"}))
    assert err.code == "slug_taken"
    assert "contact" in err.message
    again = await refused(content.create_item(db, who, "entry", {"title": "Again", "date": "2026-10-09", "slug": "contact"}, None))  # fmt: skip
    assert again.code == "slug_taken"


async def test_an_old_address_answers_301_once_the_changed_one_is_live(db, http):
    a = await content.create_item(db, who, "entry", {"title": "Opening hours", "date": "2026-10-01"}, None)  # fmt: skip
    await publish(db, [a["id"]])
    old = f"/journal/{a['slug']}/"
    assert (await http.get(old)).status_code == 200
    b = await content.update_item(db, who, a["id"], a["version"], {"slug": "hours"})
    assert b["slug"] == "hours"
    # Not live yet: the old address still shows the page.
    assert (await http.get(old)).status_code == 200
    await publish(db, [a["id"]])
    r = await http.get(old)
    assert r.status_code == 301
    assert r.headers["location"] == "/journal/hours/"
    assert (await http.get(f"/journal/{a['slug']}")).headers["location"] == "/journal/hours/"
    assert (await http.get(f"/e/{a['slug']}/")).headers["location"] == "/journal/hours/"
    assert (await http.get("/journal/hours/")).status_code == 200
    versions = await content.history(db, a["id"])
    assert versions[0]["address_change"] == {"from": a["slug"], "to": "hours"}
    assert "address_change" not in versions[1]
    # A later title change keeps the chosen address.
    c = await content.update_item(db, who, a["id"], b["version"], {"title": "When we're open"})
    assert c["slug"] == "hours"


async def test_the_review_page_shows_the_address_change(db, http):
    a = await content.create_item(db, who, "entry", {"title": "Menu today", "date": "2026-10-02"}, None)  # fmt: skip
    await publish(db, [a["id"]])
    await content.update_item(db, who, a["id"], a["version"], {"slug": "menu"})
    req = await approvals.request(db, who, [a["id"]], "")
    page = (await http.get(f"/review/{req['id']}", cookies=await signed_in(db))).text
    assert f"<p>Address changes from /journal/{a['slug']}/ to /journal/menu/</p>" in page
