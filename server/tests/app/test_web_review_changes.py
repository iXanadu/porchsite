"""The review page says what changed without opening anything: old → new per
field, a word diff for long text, the whole content for a new item, a plain
line for a removal. Port of cloudflare/test/review-changes.test.ts."""

import re

from server.app import approvals, content, history

from .web import publish, signed_in, who

WORDS = [f"w{i}" for i in range(40)]


async def review_of(db, http, ids):
    r = await approvals.request(db, who, ids, "")
    cookies = await signed_in(db)
    return (await http.get(f"/review/{r['id']}", cookies=cookies)).text


async def test_shows_a_changed_cards_fields_old_to_new_open_before_the_separate_decision(db, http):
    c = await content.create_item(db, who, "card", {"name": "Ledger", "description": "Books kept by hand.", "visibility": "public"}, None)  # fmt: skip
    await publish(db, [c["id"]])
    c2 = await content.update_item(db, who, c["id"], c["version"], {"description": "Books kept for you.", "visibility": "mention"})  # fmt: skip
    page = await review_of(db, http, [c2["id"]])
    assert "Changed card: Ledger" in page
    assert '<details class="changed" open><summary class="meta" style="cursor:pointer">What changed</summary>' in page  # fmt: skip
    assert '<div class="field"><b>Description</b><div class="value"><span class="old">Books kept by hand.</span> → Books kept for you.</div></div>' in page  # fmt: skip
    assert '<div class="field"><b>Visibility</b><div class="value"><span class="old">public</span> → mention</div></div>' in page  # fmt: skip
    assert re.search(r'<p class="meta">\d+ other fields unchanged</p>', page)
    assert "What it says" not in page
    # The advanced path stays shut, and comes after what changed.
    assert '<details class="one"><summary class="meta" style="cursor:pointer">Decide this one separately</summary>' in page  # fmt: skip
    assert page.index("What changed") < page.index("Decide this one separately")

    # /review/history's detail uses the same rows: putting it back changes the description back.
    latest = (await approvals.list(db))[0]
    await approvals.decide(db, latest["id"], {c2["id"]: {"decision": "approve"}}, "")
    before = next(
        p
        for p in await history.publishes(db)
        if any(i["id"] == c["id"] and i["version"] == c["version"] for i in p["items"])
    )
    back = (await http.get(f"/review/history/{before['id']}", cookies=await signed_in(db))).text
    assert '<div class="field"><b>Description</b><div class="value"><span class="old">Books kept for you.</span> → Books kept by hand.</div></div>' in back  # fmt: skip


async def test_shows_a_long_body_as_a_word_diff_not_two_copies(db, http):
    body = " ".join(WORDS)
    a = await content.create_item(db, who, "entry", {"title": "Long read", "date": "2026-10-01", "body": body}, None)  # fmt: skip
    await publish(db, [a["id"]])
    edited = " ".join("twenty" if w == "w20" else w for w in WORDS)
    a2 = await content.update_item(db, who, a["id"], a["version"], {"body": edited})
    page = await review_of(db, http, [a2["id"]])
    assert '<div class="field"><b>Text</b><div class="value diff">… w14 w15 w16 w17 w18 w19 <del>w20</del> <ins>twenty</ins> w21 w22 w23 w24 w25 w26 …</div></div>' in page  # fmt: skip
    assert body not in page


async def test_shows_a_new_items_content_open(db, http):
    c = await content.create_item(db, who, "card", {"name": "Brand new", "description": "Fresh from the kiln."}, None)  # fmt: skip
    page = await review_of(db, http, [c["id"]])
    assert "New card: Brand new" in page
    assert '<details open><summary class="meta" style="cursor:pointer">What it says</summary>' in page  # fmt: skip
    assert '<div class="field"><b>Description</b><div class="value">Fresh from the kiln.</div></div>' in page  # fmt: skip
    assert "What changed" not in page


async def test_says_plainly_that_a_removed_item_will_be_taken_off(db, http):
    c = await content.create_item(db, who, "card", {"name": "Old stall", "description": "Closed."}, None)  # fmt: skip
    await publish(db, [c["id"]])
    gone = await content.remove_item(db, who, c["id"], c["version"])
    page = await review_of(db, http, [gone["id"]])
    assert "<p>This will be taken off the site: <b>Old stall</b></p>" in page


async def test_escapes_every_value(db, http):
    c = await content.create_item(db, who, "card", {"name": "Plain", "description": "Nothing odd."}, None)  # fmt: skip
    await publish(db, [c["id"]])
    c2 = await content.update_item(db, who, c["id"], c["version"], {"description": '<script>alert("x")</script>'})  # fmt: skip
    page = await review_of(db, http, [c2["id"]])
    assert "→ &#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;</div>" in page
    assert "<script>alert" not in page


def test_a_left_out_field_and_its_stored_default_are_not_a_change():
    from server.app import changes

    old = {"name": "Ledger", "description": "Books."}
    now = content.validate("card", {"name": "Ledger", "description": "Books."})
    assert "Nothing you would see differs from what is live." in changes.what_changed(
        "card", now, old
    )
    moved = changes.what_changed("card", {**now, "description": "Books, kept."}, old)
    assert "<b>Description</b>" in moved
    assert "<b>Visibility</b>" not in moved
