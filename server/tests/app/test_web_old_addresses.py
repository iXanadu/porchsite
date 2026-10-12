"""A moved site's addresses from the older engine (server-edition extra,
SPEC §9): an image's short name and an old static file answer 301 to the
stored image, only when that image is published."""

from server.app import content, media

from .web import publish, who


def png(salt: bytes) -> bytes:
    return b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x10\x00\x00\x00\x10" + salt


async def test_old_image_addresses(db, http):
    shown = (await media.store(db, png(b"shown"), "image/png", "test")).removeprefix("/media/")
    hidden = (await media.store(db, png(b"hidden"), "image/png", "test")).removeprefix("/media/")
    # Two stored names sharing a 20-hex prefix: the short name is ambiguous.
    twin_a, twin_b = "ab" * 10 + "0" * 12 + ".png", "ab" * 10 + "1" * 12 + ".png"
    for name in (twin_a, twin_b):
        await db.execute(
            "INSERT INTO media (name, type, size, data, created_at) VALUES ($1, 'image/png', 1, '\\x00', '2026-01-01')",
            name,
        )
    await db.execute(
        "INSERT INTO old_addresses (path, target, created_at) VALUES"
        " ('/static/first-hero.jpg', $1, '2026-01-01'), ('/static/gone.jpg', $2, '2026-01-01')",
        f"/media/{shown}",
        f"/media/{hidden}",
    )
    body = f"![one](/media/{shown})\n\n![two](/media/{twin_a})\n\n![three](/media/{twin_b})"
    e = await content.create_item(
        db, who, "entry", {"title": "Pictures", "date": "2026-01-02", "body": body}, None
    )
    await publish(db, [e["id"]])

    r = await http.get(f"/media/{shown[:20]}.png")
    assert r.status_code == 301 and r.headers["location"] == f"/media/{shown}"
    assert (await http.get(r.headers["location"])).content == png(b"shown")
    assert (await http.head(f"/media/{shown[:20]}.png")).status_code == 301
    r = await http.get("/static/first-hero.jpg")
    assert r.status_code == 301 and r.headers["location"] == f"/media/{shown}"

    # Not published: nothing found through an old address (S1).
    assert (await http.get(f"/media/{hidden[:20]}.png")).status_code == 404
    assert (await http.get("/static/gone.jpg")).status_code == 404
    # Ambiguous, wrong extension, unknown, or not an old address at all.
    assert (await http.get(f"/media/{twin_a[:20]}.png")).status_code == 404
    assert (await http.get(f"/media/{shown[:20]}.jpg")).status_code == 404
    assert (await http.get(f"/media/{'0' * 20}.png")).status_code == 404
    assert (await http.get(f"/media/{shown[:21]}.png")).status_code == 404
    assert (await http.get("/static/never-was.jpg")).status_code == 404
    assert (await http.post(f"/media/{shown[:20]}.png")).status_code != 301
