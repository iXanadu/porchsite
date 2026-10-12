"""The product-page theme: a product page set like a newspaper front.
Port of cloudflare/test/product-page.test.ts."""

import json

import httpx
import pytest

from server.app import content, media
from server.app.errors import ApiError

from .web import publish, who


async def test_prints_a_product_page_from_content(db, http):
    site_item = await content.create_item(
        db,
        who,
        "site",
        {
            "title": "Kettle",
            "tagline": "Tea, on time.",
            "intro": "A timer that knows the leaf.",
            "hero_caption": "Vol. I · October 2026 · Free",
            "theme": "product-page",
            "handle": "kettle_dev",
            "footer_line": "Kettle · MIT",
            "cta_label": "Get started",
            "cta_link": "/pages/start/",
            "cta2_label": "How it works",
            "cta2_link": "/pages/how/",
            "links": [{"label": "How it works", "url": "/pages/how/"}],
            "streams": [
                {"id": "front", "title": "Front page", "layout": "feature"},
                {"id": "pages", "title": "More", "layout": "list", "intro": "Everything else."},
            ],
            "sections": ["front", "cards", "pages"],
            "cards_title": "Why it's safe",
        },
        None,
    )
    front = await content.create_item(
        db,
        who,
        "entry",
        {
            "stream": "front",
            "title": "Overview",
            "date": "2026-10-10",
            "summary": "The story.",
            "body": "## Seven steeps\n\nTimed to the second.\n\n> Patience is a leaf.",
            "stats": [{"value": "7", "label": "steeps"}, {"value": "0", "label": "burnt cups"}],
        },
        None,
    )
    how = await content.create_item(db, who, "entry", {"stream": "pages", "title": "How it works", "date": "2026-10-09", "summary": "Three steps.", "body": "Boil. Steep. Drink."}, None)  # fmt: skip
    c1 = await content.create_item(db, who, "card", {"name": "Nothing burns", "description": "It stops itself."}, None)  # fmt: skip
    await publish(db, [site_item["id"], front["id"], how["id"], c1["id"]])

    home = (await http.get("/")).text
    assert "{{" not in home
    for part in [
        '<p class="dateline">Vol. I · October 2026 · Free</p>',
        "<h1>Tea, on time.</h1>",
        '<a class="b" href="/pages/start/">Get started</a>',
        '<a class="b b2" href="/pages/how/">How it works</a>',
        '<span class="num">7</span><figcaption>steeps</figcaption>',
        "<h2>Seven steeps</h2>",
        "<blockquote>",
        "<h2>Why it&#39;s safe</h2>",
        "<h3>Nothing burns</h3>",
        f'<a href="/pages/{how["slug"]}/">How it works</a> <span>Three steps.</span>',
        '<nav>\n<a href="/pages/how/">How it works</a>',
        'href="https://x.com/kettle_dev"',
    ]:
        assert part in home, part
    # No hero image: the headline runs alone.
    assert '<div class="hero-copy solo">' in home

    page = (await http.get(f"/pages/{how['slug']}/")).text
    assert "<h1>How it works</h1>" in page
    assert "<p>Boil. Steep. Drink.</p>" in page
    assert "Everything else." in (await http.get("/pages/")).text
    missing = await http.get("/nowhere/")
    assert missing.status_code == 404
    assert 'class="dateline"' in missing.text
    assert ".numbers-rail" in (await http.get("/static/site.css")).text
    # Without a photo, the follow link is words only.
    assert (
        '<a class="follow-author" href="https://x.com/kettle_dev" aria-label="Follow on X"><span>Follow on X</span></a>'
        in home
    )


async def test_puts_the_owners_photo_in_the_follow_link_when_the_site_has_one(db, http):
    jpeg = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + bytes([5]) * 896

    async def serving(url, method="GET", headers=None, content=None):
        return httpx.Response(200, content=jpeg, headers={"content-type": "image/jpeg", "content-length": "900"})  # fmt: skip

    # An image field like the logo: copied in at save, and it needs a description.
    out = await media.localize(db, "site", {"follow_image": "https://example.com/me.jpg", "follow_image_alt": "Sam Lee"}, serving)  # fmt: skip
    assert media.LOCAL.search(out["follow_image"])
    with pytest.raises(ApiError) as e:
        await media.localize(db, "site", {"follow_image": "https://example.com/me.jpg"}, serving)
    assert "follow_image_alt" in json.dumps(e.value.to_json())
    s = await content.get_item(db, "site")
    s2 = await content.update_item(db, who, "site", s["version"], {"follow_image": out["follow_image"], "follow_image_alt": "Sam Lee"})  # fmt: skip
    await publish(db, [s2["id"]])
    home = (await http.get("/")).text
    assert (
        f'<a class="follow-author has-photo" href="https://x.com/kettle_dev" aria-label="Follow on X"><img src="{out["follow_image"]}" width="48" height="48" alt="Sam Lee"><span>Follow on X</span></a>'
        in home
    )
    assert (
        ".follow-author.has-photo span { display: none; }"
        in (await http.get("/static/site.css")).text
    )
