"""The site's mark and share picture, as the product-page theme prints them,
over HTTP. Port of cloudflare/test/site-images.test.ts."""

from server.app import content, media

from .web import publish, signed_in, who


async def test_shows_the_mark_uses_it_as_the_icon_and_shares_the_share_picture(db, http):
    m = await media.store(db, bytes([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]), "image/jpeg", "test")
    site_item = await content.create_item(
        db,
        who,
        "site",
        {"title": "Kettle", "tagline": "Tea.", "theme": "product-page", "logo": m, "logo_alt": "A kettle", "share_image": m, "share_image_alt": "A kettle on a stove"},
        None,
    )  # fmt: skip
    await publish(db, [site_item["id"]])
    home = (await http.get("/")).text
    assert f'<img class="brand-mark press-img" src="{m}" alt="A kettle"' in home
    assert f'<link rel="icon" href="{m}">' in home
    assert f'<meta name="twitter:image" content="https://site.example{m}">' in home
    assert '<meta name="twitter:image:alt" content="A kettle on a stove">' in home
    r = await http.get(m)
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


async def test_an_unpublished_image_is_only_the_owners(db, http):
    m = await media.store(db, bytes([0x89, 0x50, 0x4E, 0x47, 9, 9, 9]), "image/png", "test")
    hidden = await http.get(m)
    assert hidden.status_code == 404
    assert "Not found" in hidden.text or "Nothing here." in hidden.text
    mine = await http.get(m, cookies=await signed_in(db))
    assert mine.status_code == 200
    assert mine.headers["cache-control"] == "private, no-store"
