"""Whole-site revert (spec S5, §5): the owner puts the site back to an
earlier publish, as a new publish. Port of cloudflare/test/history.test.ts."""

import re

from server.app import approvals, content, history

from .web import signed_in

who = "assistant:Helper"


async def publish(db, ids):
    req = await approvals.request(db, who, ids, "")
    await approvals.decide(db, req["id"], {i: {"decision": "approve"} for i in ids}, "")


def csrf_of(page: str) -> str:
    return re.search(r'name="csrf" value="([^"]+)"', page).group(1)


async def test_lists_publishes_and_puts_the_whole_site_back_as_a_new_publish(db, http):
    s = await content.create_item(db, who, "site", {"title": "Kettle", "tagline": "Tea."}, None)
    await publish(db, [s["id"]])  # 1
    a = await content.create_item(db, who, "entry", {"title": "First pot", "date": "2026-10-01"}, None)  # fmt: skip
    await publish(db, [a["id"]])  # 2
    s2 = await content.update_item(db, who, s["id"], s["version"], {"tagline": "Coffee."})
    b = await content.create_item(db, who, "entry", {"title": "Switching", "date": "2026-10-02"}, None)  # fmt: skip
    await publish(db, [s2["id"], b["id"]])  # 3
    # A draft on the site item: the revert sets it aside, and it stays in history.
    draft = await content.update_item(db, who, s["id"], s2["version"], {"tagline": "Cocoa?"})

    cookies = await signed_in(db)
    page = (await http.get("/review/history", cookies=cookies)).text
    assert page.index("Switching") < page.index("First pot")
    assert "you approved Helper&#39;s request" in page
    assert '<p class="meta">This is the site now.</p>' in page
    assert '<a class="go" href="/review/history/2">Put the site back to this →</a>' in page

    confirm = (await http.get("/review/history/2", cookies=cookies)).text
    assert "<h1>Put the site back?</h1>" in confirm
    assert '<h2 style="margin-top:8px">Your site&#39;s text and look</h2><div class="meta">site · put back</div>' in confirm  # fmt: skip
    assert '<h2 style="margin-top:8px">Switching</h2><div class="meta">entry · taken off</div>' in confirm  # fmt: skip
    assert "First pot" not in confirm

    done = await http.post("/review/history/2", data={"csrf": csrf_of(confirm), "note": "Wrong tagline"}, cookies=cookies)  # fmt: skip
    assert "<h1>Your site is back</h1>" in done.text
    home = (await http.get("/")).text
    assert "Tea." in home
    assert "Coffee." not in home
    assert "Switching" not in home
    assert "First pot" in home
    last = (await history.publishes(db))[0]
    assert (last["id"], last["actor"], last["approval_id"], last["note"]) == (4, "owner", None, "Put the site back to publish 2: Wrong tagline")  # fmt: skip
    assert [[i["label"], i["removed"]] for i in last["items"]] == [["Switching", True], ["Your site's text and look", False]]  # fmt: skip
    versions = await content.history(db, s["id"])
    assert (versions[0]["version"], versions[0]["action"], versions[0]["actor"]) == (draft["version"] + 1, "revert", "owner")  # fmt: skip
    assert versions[0]["data"]["tagline"] == "Tea."
    assert versions[1]["data"]["tagline"] == "Cocoa?"
    assert "<p>Put the site back to publish 2: Wrong tagline</p>" in (await http.get("/review/history", cookies=cookies)).text  # fmt: skip

    # A revert can itself be reverted.
    await history.revert(db, 3, "")
    again = (await http.get("/")).text
    assert "Coffee." in again
    assert "Switching" in again
    assert (await history.publishes(db))[0]["note"] == "Put the site back to publish 3"


async def test_never_brings_a_card_back_more_visible_than_it_is_now(db):
    c = await content.create_item(db, who, "card", {"name": "Lantern", "description": "Old words."}, None)  # fmt: skip
    await publish(db, [c["id"]])  # 6
    c2 = await content.update_item(db, who, c["id"], c["version"], {"description": "New words.", "visibility": "private"})  # fmt: skip
    await publish(db, [c2["id"]])  # 7
    await history.revert(db, 6, "")
    now = await content.get_item(db, c["id"])
    assert (now["data"]["description"], now["data"]["visibility"]) == ("Old words.", "private")


async def test_says_when_the_site_already_matches_and_refuses_a_stale_form(db, http):
    cookies = await signed_in(db)
    latest = (await history.publishes(db))[0]["id"]
    assert "<p>The site already matches this.</p>" in (await http.get(f"/review/history/{latest}", cookies=cookies)).text  # fmt: skip
    stale = (await http.post("/review/history/2", data={"csrf": "nope"}, cookies=cookies)).text
    assert '<p class="error">This form expired. Try again.</p>' in stale
    same = (await http.post(f"/review/history/{latest}", data={"csrf": csrf_of(stale)}, cookies=cookies)).text  # fmt: skip
    assert '<p class="error">The site already matches that publish.</p>' in same
    assert (await http.get("/review/history")).status_code == 303
    assert (await http.get("/review/history/999", cookies=cookies)).status_code == 404
