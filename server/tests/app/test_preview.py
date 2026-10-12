"""The owner sees the site as it will look before approving: a theme switch
included. Port of the proposedView part of cloudflare/test/preview.test.ts
(the sign-in, the review page and its form belong to the routes)."""

from server.app import approvals, content, site

who = "assistant:test"
ORIGIN = "https://site.example"


async def test_shows_the_proposed_site_in_the_proposed_theme(db):
    s = await content.create_item(
        db, who, "site", {"title": "Kettle", "tagline": "Tea.", "theme": "personal-homepage"}, None
    )
    r1 = await approvals.request(db, who, [s["id"]], "")
    await approvals.decide(db, r1["id"], {s["id"]: {"decision": "approve"}}, "")
    s2 = await content.update_item(
        db,
        who,
        s["id"],
        s["version"],
        {"tagline": "Tea, on time.", "theme": "product-page", "hero_caption": "Vol. I"},
    )
    r2 = await approvals.request(db, who, [s2["id"]], "")

    text = await site.preview_page(db, r2["id"], ORIGIN)
    # The proposed theme's own stylesheet (live is still personal-homepage), inline, with its palette.
    assert "<style>" in text
    assert ".numbers-rail" in text
    assert ":root{--bg:" in text
    assert 'href="/static/site.css' not in text
    assert '<p class="dateline">Vol. I</p>' in text
    assert "<h1>Tea, on time.</h1>" in text
    # The public site hasn't changed.
    assert "Tea, on time." not in await site.home_page(db, ORIGIN)
    v = await site.proposed_view(db, [{"id": s2["id"], "version": s2["version"]}])
    assert v.site["theme"] == "product-page"
    assert (await site.live_view(db)).site["theme"] == "personal-homepage"
    # Approving everything waiting publishes it.
    await approvals.decide(db, r2["id"], {s2["id"]: {"decision": "approve"}}, "")
    assert "Tea, on time." in await site.home_page(db, ORIGIN)
