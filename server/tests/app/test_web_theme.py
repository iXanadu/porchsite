"""The personal-homepage theme, rendered by the web app from its own content.
Port of the route part of cloudflare/test/theme.test.ts (the image size
cases are in test_media.py)."""

import re

from server.app import content

from .web import publish, who


async def test_renders_every_page_from_content_with_nothing_unapproved(db, http):
    site_item = await content.create_item(
        db,
        who,
        "site",
        {
            "title": "Sam's site",
            "tagline": "I build boats.",
            "intro": "Mostly wooden ones.",
            "theme": "personal-homepage",
            "handle": "sam_builds",
            "footer_line": "Open to commissions.",
            "contact_line": "DM me on X",
            "cta_label": "See the work",
            "cta_link": "/writing/",
            "cta2_label": "My writing",
            "timezone": "America/Chicago",
            "cards_aside": "Open source",
            "cta2_link": "/#writing",
            "streams": [
                {"id": "journal", "title": "The log", "byline": "kept by an assistant", "layout": "feature", "author": "Helper", "intro": "What happened this week.", "path": "log", "anchor": "hands"},
                {"id": "writing", "title": "My writing", "byline": "Written by me", "layout": "list", "link_label": "Read on Substack", "nav_label": "Writing", "description": "Essays by @{handle}.", "feed_subtitle": "New essays by @{handle}."},
            ],
            "sections": ["journal", "cards", "writing", "about"],
            "about": "First paragraph.\n\nSecond paragraph.",
        },
        None,
    )  # fmt: skip
    j1 = await content.create_item(db, who, "entry", {"stream": "journal", "title": "Hull done", "date": "2026-10-08", "summary": "Planked.", "body": "All **planked**.", "stats": [{"value": "12", "label": "planks"}]}, None)  # fmt: skip
    j2 = await content.create_item(db, who, "entry", {"stream": "journal", "title": "Keel laid", "date": "2026-10-01", "summary": "Started."}, None)  # fmt: skip
    w1 = await content.create_item(db, who, "entry", {"stream": "writing", "title": "Why wood", "date": "2026-10-05", "summary": "An essay.", "external_url": "https://example.com/why-wood", "tags": ["boats"]}, None)  # fmt: skip
    c1 = await content.create_item(db, who, "card", {"name": "Skiff", "description": "A small boat.", "badge": "Live", "badge_tone": "live", "group": "Boats"}, None)  # fmt: skip
    c2 = await content.create_item(db, who, "card", {"name": "Plans", "description": "Free boat plans.", "link": "https://example.org/plans", "group": "Open source"}, None)  # fmt: skip
    n1 = await content.create_item(db, who, "note", {"text": "Bought cedar.", "date": "2026-10-07"}, None)  # fmt: skip
    hidden = await content.create_item(db, who, "entry", {"stream": "journal", "title": "Not approved yet", "date": "2026-10-09", "summary": "x"}, None)  # fmt: skip
    await publish(db, [site_item["id"], j1["id"], j2["id"], w1["id"], c1["id"], c2["id"], n1["id"]])

    r = await http.get("/")
    assert r.headers["cache-control"] == "public, no-cache, must-revalidate, no-transform"
    assert "default-src 'none'" in r.headers["content-security-policy"]
    assert r.headers["x-porchsite-release"] == "test"
    home = r.text
    for part in ["I build boats.", "The log", "kept by an assistant", "What happened this week.", "Hull done", "planks", "Bought cedar.", "Skiff", "My writing", "Why wood", "Read on Substack", "Second paragraph.", "Open to commissions.", "https://x.com/sam_builds", "See the work", "All of The log", 'href="/log/"']:  # fmt: skip
        assert part in home, part
    assert "{{" not in home
    assert 'href="/#writing">My writing</a>' in home
    assert "badge-live" in home
    assert re.search(
        r'<h3 class="group-label">Open source</h3>\s*<div class="cards">\s*<a class="card" data-group="open-source" href="https://example.org/plans">',
        home,
    )
    assert re.search(r"Last update [A-Z][a-z]{2} \d+, \d+:\d\d [AP]M CT", home)
    assert "Not approved yet" not in home
    assert hidden["id"]

    moved = await http.get(f"/e/{j1['slug']}/")
    assert moved.status_code == 301
    assert moved.headers["location"] == f"/log/{j1['slug']}/"
    assert '<section id="hands">' in home
    page = (await http.get(f"/log/{j1['slug']}/")).text
    assert "<strong>planked</strong>" in page
    assert "kept by an assistant" in page
    assert (await http.get(f"/e/{w1['slug']}/")).headers[
        "location"
    ] == "https://example.com/why-wood"

    archive = (await http.get("/log/")).text
    assert "Keel laid" in archive
    assert "What happened this week." in archive
    assert "Why wood" in (await http.get("/writing/tags/boats/")).text
    assert 'content="Essays by @sam_builds."' in (await http.get("/writing/")).text
    wfeed = (await http.get("/writing/feed.xml")).text
    assert "<subtitle>New essays by @sam_builds.</subtitle>" in wfeed
    assert "<title>Writing · Sam&#39;s site</title>" in wfeed
    assert "<author><name>@sam_builds</name></author>" in wfeed
    assert '<link href="https://site.example/writing/"/>' in wfeed

    index = (await http.get("/writing/search.json")).json()
    assert len(index) == 1 and index[0]["t"] == "Why wood" and index[0]["x"] is True

    atom = await http.get("/log/feed.xml")
    assert "atom" in atom.headers["content-type"]
    assert "<title>Hull done</title>" in atom.text
    assert "<author><name>Helper for @sam_builds</name></author>" in atom.text
    assert "Not approved yet" not in atom.text
    assert 'href="/log/feed.xml"' in home

    css = await http.get("/static/site.css")
    assert "text/css" in css.headers["content-type"]
    missing = await http.get("/nowhere/")
    assert missing.status_code == 404
    assert missing.headers["cache-control"] == "no-store"
    assert missing.text == '<!doctype html><title>Not found</title>'
    assert missing.headers['cache-control'] == 'no-store'
    assert 'etag' not in missing.headers
    # The owner's pages are untouched by the theme.
    assert (await http.get("/review")).status_code == 303
