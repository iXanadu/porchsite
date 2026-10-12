"""The site's mark and share picture, as the product-page theme prints them
(service level). Port of cloudflare/test/site-images.test.ts."""

from server.app import approvals, content, media, site

who = "assistant:test"
ORIGIN = "https://site.example"


async def publish(db, ids):
    req = await approvals.request(db, who, ids, "")
    await approvals.decide(db, req["id"], {i: {"decision": "approve"} for i in ids}, "")


async def test_shows_the_mark_uses_it_as_the_icon_and_shares_the_share_picture(db):
    m = await media.store(db, bytes([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]), "image/jpeg", "test")
    site_item = await content.create_item(
        db,
        who,
        "site",
        {
            "title": "Kettle",
            "tagline": "Tea.",
            "theme": "product-page",
            "logo": m,
            "logo_alt": "A kettle",
            "share_image": m,
            "share_image_alt": "A kettle on a stove",
        },
        None,
    )
    await publish(db, [site_item["id"]])
    home = await site.home_page(db, ORIGIN)
    assert f'<img class="brand-mark press-img" src="{m}" alt="A kettle"' in home
    assert f'<link rel="icon" href="{m}">' in home
    assert f'<meta name="twitter:image" content="{ORIGIN}{m}">' in home
    assert '<meta name="twitter:image:alt" content="A kettle on a stove">' in home
    # GET /media/<name>: public now that a published item uses it.
    name = m.removeprefix("/media/")
    assert await media.published(db, name)
    shown = await media.serve(db, name, True)
    assert shown is not None and shown["body"][:3] == b"\xff\xd8\xff"
    assert shown["headers"]["Content-Type"] == "image/jpeg"
