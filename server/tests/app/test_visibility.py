"""Card visibility (spec §3): public, mention or private, checked when saved
and when published. Port of cloudflare/test/visibility.test.ts."""

import json
import re

import pytest

from server.app import approvals, content, site
from server.app.errors import ApiError

from .web import publish, signed_in, who


async def refused(coro) -> ApiError:
    with pytest.raises(ApiError) as e:
        await coro
    return e.value


async def find(db, name):
    return next(i for i in await content.all_items(db) if i["data"].get("name") == name)


async def test_shows_a_public_card_whole_a_mention_as_name_and_description_a_private_card_never(
    db, http
):
    s = await content.create_item(
        db, who, "site", {"title": "Kettle", "cards_title": "Things"}, None
    )
    pub = await content.create_item(db, who, "card", {"name": "Teapot", "description": "Pours.", "link": "https://example.com/teapot", "link_label": "See the teapot"}, None)  # fmt: skip
    assert pub["data"]["visibility"] == "public"
    men = await content.create_item(db, who, "card", {"name": "Sieve", "description": "Strains.", "link": "https://example.com/sieve", "link_label": "See the sieve", "visibility": "mention"}, None)  # fmt: skip
    pri = await content.create_item(db, who, "card", {"name": "Lantern", "description": "Lantern glows.", "link": "https://example.com/lantern", "visibility": "private"}, None)  # fmt: skip
    await publish(db, [s["id"], pub["id"], men["id"], pri["id"]])
    v = await site.live_view(db)
    assert [c["name"] for c in v.cards] == ["Sieve", "Teapot"]
    sieve = next(c for c in v.cards if c["name"] == "Sieve")
    assert {k: sieve[k] for k in ("link", "link_label", "image", "image_alt", "description")} == {"link": "", "link_label": "", "image": "", "image_alt": "", "description": "Strains."}  # fmt: skip
    home = (await http.get("/")).text
    assert "See the teapot" in home
    assert "Sieve" in home
    assert "Strains." in home
    assert "See the sieve" not in home
    assert "example.com/sieve" not in home
    assert "Lantern" not in home
    bad = await refused(content.create_item(db, who, "card", {"name": "Cup", "description": "Holds.", "visibility": "hidden"}, None))  # fmt: skip
    assert bad.code == "invalid"


async def test_refuses_content_that_names_a_private_card_as_a_whole_word_in_any_case(db):
    hit = await refused(content.create_item(db, who, "entry", {"title": "News", "date": "2026-10-01", "summary": "Working on the LANTERN."}, None))  # fmt: skip
    assert hit.code == "content_guard"
    assert "private card" in hit.message
    assert hit.to_json()["rule"] == "a private card's name"
    # Part of a longer word isn't the name; a card may name itself.
    ok = await content.create_item(db, who, "entry", {"title": "News", "date": "2026-10-01", "summary": "Lanterns everywhere."}, None)  # fmt: skip
    assert ok["version"] == 1
    assert (await refused(content.update_item(db, who, ok["id"], 1, {"body": "Soon: lantern."}))).code == "content_guard"  # fmt: skip
    pri = await find(db, "Lantern")
    up = await content.update_item(db, who, pri["id"], pri["version"], {"description": "The Lantern, brighter."})  # fmt: skip
    assert up["version"] == pri["version"] + 1


async def test_refuses_making_a_card_private_while_other_items_name_it(db):
    teapot = await find(db, "Teapot")
    n = await content.create_item(db, who, "note", {"text": "Polished the teapot.", "date": "2026-10-02"}, None)  # fmt: skip
    err = await refused(content.update_item(db, who, teapot["id"], teapot["version"], {"visibility": "private"}))  # fmt: skip
    assert err.code == "name_in_use"
    assert err.to_json()["items"] == [n["id"]]
    await content.update_item(db, who, n["id"], 1, {"text": "Polished something."})
    made = await content.update_item(db, who, teapot["id"], teapot["version"], {"visibility": "private"})  # fmt: skip
    assert made["data"]["visibility"] == "private"
    # Back to public, for the cases below.
    await content.update_item(db, who, teapot["id"], made["version"], {"visibility": "public"})


async def test_lets_an_entry_name_a_mention_card_once_in_its_summary_and_once_in_its_body(db):
    twice = await refused(content.create_item(db, who, "entry", {"title": "Sieves", "date": "2026-10-03", "summary": "The sieve, and the sieve again."}, None))  # fmt: skip
    assert twice.code == "mention_limit"
    assert (
        twice.message
        == 'This entry names "Sieve" more than once in its summary. A card shown as a mention gets one line: name it once, or make the card public.'
    )
    body = await refused(content.create_item(db, who, "entry", {"title": "Sieves", "date": "2026-10-03", "body": "Sieve.\n\nSieve."}, None))  # fmt: skip
    assert body.code == "mention_limit"
    once = await content.create_item(db, who, "entry", {"title": "Sieves", "date": "2026-10-03", "summary": "A sieve.", "body": "The sieve strains."}, None)  # fmt: skip
    assert once["version"] == 1


async def test_keeps_a_cards_visibility_through_a_rollback(db):
    c = await content.create_item(db, who, "card", {"name": "Kettle lid", "description": "Fits.", "visibility": "mention"}, None)  # fmt: skip
    c2 = await content.update_item(db, who, c["id"], 1, {"description": "Fits snugly.", "visibility": "public"})  # fmt: skip
    back = await content.rollback(db, who, c["id"], 1, c2["version"])
    assert back["data"]["description"] == "Fits."
    assert back["data"]["visibility"] == "public"


async def test_refuses_to_publish_live_text_that_names_a_private_card(db, http):
    # Text written before the card was private (put in directly: every save refuses it now).
    ent = await content.create_item(db, who, "entry", {"title": "Old news", "date": "2026-10-04", "summary": "Nothing yet."}, None)  # fmt: skip
    data = json.dumps({**ent["data"], "summary": "Working on the Lantern."}, separators=(",", ":"))
    await db.execute("UPDATE items SET data = $1 WHERE id = $2", data, ent["id"])
    await db.execute("UPDATE revisions SET data = $1 WHERE item_id = $2 AND version = 1", data, ent["id"])  # fmt: skip
    req = await approvals.request(db, who, [ent["id"]], "")
    err = await refused(approvals.decide(db, req["id"], {ent["id"]: {"decision": "approve"}}, ""))
    assert err.code == "content_guard"
    assert "Old news" in err.message
    assert await db.fetchrow("SELECT 1 FROM live WHERE item_id = $1", ent["id"]) is None
    assert (await approvals.get(db, req["id"]))["items"][0]["status"] == "pending"
    # The owner sees why on the review page.
    cookies = await signed_in(db)
    review = (await http.get(f"/review/{req['id']}", cookies=cookies)).text
    csrf = re.search(r'name="csrf" value="([^"]+)"', review).group(1)
    page = (await http.post(f"/review/{req['id']}", data={"csrf": csrf, "all": "approve"}, cookies=cookies)).text  # fmt: skip
    assert (
        '<p class="error">Some items can&#39;t go public as they stand: they name a private card (Old news).'
        in page
    )


async def test_warns_on_the_review_page_and_the_preview_when_a_change_shows_more_of_a_card(
    db, http
):
    pri = await find(db, "Lantern")
    raised = await content.update_item(db, who, pri["id"], pri["version"], {"visibility": "public"})
    req = await approvals.request(db, who, [raised["id"]], "")
    cookies = await signed_in(db)
    line = "Shows more: the card &#34;Lantern&#34; goes from private (not shown) to public (the whole card)."
    review = (await http.get(f"/review/{req['id']}", cookies=cookies)).text
    assert f'<p class="warn">{line}</p>' in review
    assert line in (await http.get(f"/review/{req['id']}/preview", cookies=cookies)).text
    # A change that shows less says nothing.
    teapot = await find(db, "Teapot")
    lower = await content.update_item(db, who, teapot["id"], teapot["version"], {"visibility": "mention"})  # fmt: skip
    quiet = await approvals.request(db, who, [lower["id"]], "")
    assert 'class="warn"' not in (await http.get(f"/review/{quiet['id']}", cookies=cookies)).text
