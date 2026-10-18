"""The built-in look (no installed theme named), the photo upload page, and
the headers every answer carries. Port of cloudflare/src/site.ts's pages and
routes.ts's upload page."""

from server.app import content, uploads

from .web import publish, who

PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 1])  # fmt: skip


async def test_the_built_in_look(db, http):
    empty = await http.get("/")
    assert empty.status_code == 200
    assert "<title>My site</title>" in empty.text
    assert "Kept up to date by an assistant, published with the owner's approval." in empty.text
    s = await content.create_item(
        db,
        who,
        "site",
        {
            "title": "Sam & Co",
            "tagline": "Boats.",
            "owner_name": "Sam",
            "links": [{"label": "About", "url": "/#about"}],
            "about": "We **build**.",
            "streams": [{"id": "journal", "title": "Log", "byline": "by an assistant"}, {"id": "work", "title": "Work", "layout": "cards", "link_label": "Visit"}],
        },
        None,
    )  # fmt: skip
    e = await content.create_item(db, who, "entry", {"title": "Hull", "date": "2026-10-08", "summary": "Planked.", "body": "Done.", "tags": ["wood"], "stats": [{"value": "3", "label": "coats"}]}, None)  # fmt: skip
    w = await content.create_item(db, who, "entry", {"stream": "work", "title": "Skiff", "date": "2026-10-02", "external_url": "https://example.com/skiff"}, None)  # fmt: skip
    c = await content.create_item(db, who, "card", {"name": "Oars", "description": "Ash.", "badge": "New", "link": "https://example.org/oars"}, None)  # fmt: skip
    n = await content.create_item(db, who, "note", {"text": "Bought cedar.", "date": "2026-10-07", "link": "/journal/"}, None)  # fmt: skip
    await publish(db, [s["id"], e["id"], w["id"], c["id"], n["id"]])
    home = (await http.get("/")).text
    for part in [
        "<title>Sam &#38; Co</title>",
        '<a class="logo" href="/">Sam &#38; Co</a><nav><a href="/#about">About</a></nav>',
        "<h1>Boats.</h1>",
        '<section id="journal"><h2>Log</h2><p class="byline">by an assistant</p><div class="entry"><div class="meta">October 8, 2026</div>',
        '<div class="cards"><div class="card"><div class="meta">October 2, 2026</div><h3><a href="https://example.com/skiff">Skiff</a></h3><a href="https://example.com/skiff">Visit →</a></div></div>',
        '<h3>Oars <span class="badge">New</span></h3><p>Ash.</p><a href="https://example.org/oars">https://example.org/oars</a>',
        '<li><span class="meta">Oct 7</span><span><a href="/journal/">Bought cedar.</a></span></li>',
        "<p>We <strong>build</strong>.</p>",
        "<footer>Sam · Kept up to date",
    ]:
        assert part in home, part
    page = await http.get(f"/journal/{e['slug']}/")
    assert page.status_code == 200
    assert "<title>Hull · Sam &#38; Co</title>" in page.text
    assert '<div class="stat"><b>3</b><span>coats</span></div></div><p>Done.</p><p class="tags"><span class="meta">#wood</span> </p>' in page.text  # fmt: skip
    away = await http.get(f"/work/{w['slug']}/")
    assert (away.status_code, away.headers["location"]) == (302, "https://example.com/skiff")
    missing = await http.get("/journal/nothing/")
    assert missing.status_code == 404
    assert missing.text == '<!doctype html><title>Not found</title>'
    assert missing.headers['cache-control'] == 'no-store'
    assert 'etag' not in missing.headers
    assert missing.headers["cache-control"] == "no-store"


async def test_the_photo_upload_page(db, http):
    u = await uploads.create(db, who, "the cover")
    page = await http.get(u["path"])
    assert page.status_code == 200
    assert "<p>For: the cover</p>" in page.text
    assert "createImageBitmap" in page.text
    no_alt = await http.post(
        u["path"], files={"photo": ("p.png", PNG, "image/png")}, data={"alt": " "}
    )
    assert "Please describe the photo" in no_alt.text
    done = await http.post(
        u["path"], files={"photo": ("p.png", PNG, "image/png")}, data={"alt": "A hull"}
    )
    assert "Got it, thank you" in done.text
    assert (await http.get(u["path"])).status_code == 410
    again = await http.post(u["path"], files={"photo": ("p.png", PNG, "image/png")}, data={"alt": "x"}, headers={"accept": "application/json"})  # fmt: skip
    assert again.status_code == 410 and again.json()["error"] == "link_used"


async def test_every_answer_says_its_release(http):
    for path in (
        "/",
        "/robots.txt",
        "/review",
        "/nowhere",
        "/.well-known/oauth-authorization-server",
    ):
        assert (await http.get(path)).headers["x-porchsite-release"] == "test", path
    # HEAD gets the GET's status and headers, no body.
    head = await http.head("/")
    assert head.status_code == 200
    assert head.content == b"" and head.headers["x-porchsite-release"] == "test"
