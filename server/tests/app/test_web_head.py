"""HEAD is GET without the body, on every address (SPEC §6): pages, feeds,
static files, media and the 404 page, in the built-in look and a theme.
Port of cloudflare/test/head.test.ts."""

from server.app import content, media

from .web import publish, who

state: dict[str, str] = {}


async def same(http, path: str, status: int) -> None:
    """GET and HEAD agree on status and type; HEAD has no body."""
    get = await http.get(path)
    head = await http.head(path)
    assert (path, get.status_code) == (path, status)
    assert (path, head.status_code) == (path, status)
    assert head.headers.get("content-type") == get.headers.get("content-type"), path
    assert head.headers.get("cache-control") == get.headers.get("cache-control"), path
    assert len(get.content) > 0, path
    assert head.content == b"", path


async def test_answers_like_get_in_the_built_in_look(db, http):
    image = await media.store(db, bytes([0x89, 0x50, 0x4E, 0x47, 9, 9, 9]), "image/png", "test")
    s = await content.create_item(
        db,
        who,
        "site",
        {"title": "Boats", "tagline": "Built by hand.", "streams": [{"id": "journal", "title": "Log"}], "logo": image, "logo_alt": "A boat"},
        None,
    )  # fmt: skip
    en = await content.create_item(db, who, "entry", {"stream": "journal", "title": "Hull", "date": "2026-10-08", "body": "Done."}, None)  # fmt: skip
    await publish(db, [s["id"], en["id"]])
    state["entry"] = f"/journal/{en['slug']}/"
    state["image"] = image
    await same(http, "/", 200)
    await same(http, state["entry"], 200)
    await same(http, "/journal/feed.xml", 200)
    await same(http, image, 200)
    await same(http, "/robots.txt", 200)
    await same(http, "/static/a.js", 200)
    await same(http, "/journal/nothing/", 404)
    await same(http, "/nowhere", 404)


async def test_answers_like_get_in_a_theme(db, http):
    s = await content.get_item(db, "site")
    await content.update_item(
        db, who, "site", s["version"], {**s["data"], "theme": "personal-homepage"}
    )
    await publish(db, ["site"])
    assert "/static/site.css" in (await http.get("/")).text
    await same(http, "/", 200)
    await same(http, state["entry"], 200)
    await same(http, "/journal/", 200)
    await same(http, "/journal/feed.xml", 200)
    await same(http, "/static/site.css", 200)
    await same(http, state["image"], 200)
    await same(http, "/journal/nothing/", 404)
    await same(http, "/nowhere", 404)
