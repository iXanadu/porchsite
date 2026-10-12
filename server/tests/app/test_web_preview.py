"""The owner sees the site as it will look before approving (a theme switch
included), reads the plain review page, and approves with one button. Port of
cloudflare/test/preview.test.ts."""

import re

from server.app import approvals, content

from .web import signed_in, who


async def test_shows_the_proposed_site_in_the_proposed_theme_only_to_the_owner(db, http):
    s = await content.create_item(db, who, "site", {"title": "Kettle", "tagline": "Tea.", "theme": "personal-homepage"}, None)  # fmt: skip
    r1 = await approvals.request(db, who, [s["id"]], "")
    await approvals.decide(db, r1["id"], {s["id"]: {"decision": "approve"}}, "")
    s2 = await content.update_item(db, who, s["id"], s["version"], {"tagline": "Tea, on time.", "theme": "product-page", "hero_caption": "Vol. I"})  # fmt: skip
    r2 = await approvals.request(db, who, [s2["id"]], "")

    assert (await http.get(f"/review/{r2['id']}/preview")).status_code == 303
    cookies = await signed_in(db)
    page = await http.get(f"/review/{r2['id']}/preview", cookies=cookies)
    assert page.headers["cache-control"] == "no-store"
    assert page.headers["x-robots-tag"] == "noindex"
    assert "form-action 'self'" in page.headers["content-security-policy"]
    text = page.text
    assert "Preview: nothing is live yet." in text
    # The proposed theme's own stylesheet (live is still personal-homepage), inline, with its palette.
    assert "<style>" in text
    assert ".numbers-rail" in text
    assert ":root{--bg:" in text
    assert 'href="/static/site.css' not in text
    assert 'value="approve"' in text
    assert '<p class="dateline">Vol. I</p>' in text
    assert "<h1>Tea, on time.</h1>" in text
    # The public site hasn't changed.
    assert "Tea, on time." not in (await http.get("/")).text
    review = (await http.get(f"/review/{r2['id']}", cookies=cookies)).text
    assert f'href="/review/{r2["id"]}/preview"' in review
    assert "wants to change 1 thing on your site." in review
    assert "Changes to your site&#39;s text and look" in review
    assert (
        '<summary class="meta" style="cursor:pointer">What changed</summary><div class="field"><b>Headline</b><div class="value"><span class="old">Tea.</span> → Tea, on time.</div></div>'
        in review
    )
    assert "version" not in review
    # One big button approves everything waiting, and says so.
    csrf = re.search(r'name="csrf" value="([^"]+)"', review).group(1)
    done = await http.post(
        f"/review/{r2['id']}", data={"csrf": csrf, "all": "approve"}, cookies=cookies
    )
    assert "Your site is updated" in done.text
    assert "Tea, on time." in (await http.get("/")).text


async def test_asking_for_changes_needs_a_note(db, http):
    s = await content.get_item(db, "site")
    s2 = await content.update_item(db, who, "site", s["version"], {"tagline": "Tea, always."})
    r = await approvals.request(db, who, [s2["id"]], "")
    cookies = await signed_in(db)
    review = (await http.get(f"/review/{r['id']}", cookies=cookies)).text
    csrf = re.search(r'name="csrf" value="([^"]+)"', review).group(1)
    empty = await http.post(f"/review/{r['id']}", data={"csrf": csrf, "all": "changes", "note_all": " "}, cookies=cookies)  # fmt: skip
    assert "Say what should change" in empty.text
    sent = await http.post(f"/review/{r['id']}", data={"csrf": csrf, "all": "changes", "note_all": "Shorter, please."}, cookies=cookies)  # fmt: skip
    assert "Your assistant has been told" in sent.text
    got = await approvals.get(db, r["id"])
    assert got["items"][0]["status"] == "changes_requested"
    assert got["items"][0]["note"] == "Shorter, please."
    assert "Tea, always." not in (await http.get("/")).text


async def test_separate_choices_and_a_stale_form(db, http):
    e1 = await content.create_item(db, who, "entry", {"title": "One", "date": "2026-10-01"}, None)
    e2 = await content.create_item(db, who, "entry", {"title": "Two", "date": "2026-10-02"}, None)
    r = await approvals.request(db, who, [e1["id"], e2["id"]], "Two pages")
    cookies = await signed_in(db)
    review = (await http.get(f"/review/{r['id']}", cookies=cookies)).text
    assert "wants to add 2 things on your site." in review
    assert "Decide this one separately" in review
    stale = await http.post(f"/review/{r['id']}", data={"csrf": "nope", "all": "approve"}, cookies=cookies)  # fmt: skip
    assert "This form expired. Try again." in stale.text
    csrf = re.search(r'name="csrf" value="([^"]+)"', review).group(1)
    form = {"csrf": csrf, "all": "each", f"d_{e1['id']}": "approve", f"d_{e2['id']}": "deny", f"n_{e2['id']}": "Not this one."}  # fmt: skip
    back = await http.post(f"/review/{r['id']}", data=form, cookies=cookies)
    assert back.status_code == 303
    assert back.headers["location"] == f"https://site.example/review/{r['id']}"
    got = {i["id"]: i for i in (await approvals.get(db, r["id"]))["items"]}
    assert got[e1["id"]]["status"] == "published"
    assert (got[e2["id"]]["status"], got[e2["id"]]["note"]) == ("denied", "Not this one.")
    index = (await http.get("/review", cookies=cookies)).text
    assert "Decided" in index and "One" in index


async def test_a_decision_posted_without_the_owner_publishes_nothing(db, http):
    e = await content.create_item(db, who, "entry", {"title": "Sneaky", "date": "2026-10-03"}, None)
    r = await approvals.request(db, who, [e["id"]], "")
    form = await http.post(f"/review/{r['id']}", data={f"d_{e['id']}": "approve", "all": "approve"})
    assert form.status_code == 303
    assert "/login?next=%2Freview%2F" in form.headers["location"]
    assert (await approvals.get(db, r["id"]))["items"][0]["status"] == "pending"
