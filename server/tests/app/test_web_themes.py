"""A catalog theme, installed, renders the site over HTTP once approved.
Port of the route part of cloudflare/test/themes.test.ts (the rest is
test_themes.py)."""

from server.app import approvals, content, themes

from .test_themes import catalog
from .web import who


async def test_the_site_renders_with_an_installed_theme_once_approved(db, http):
    assert await themes.install(db, "harbor", who, catalog()) == {
        "name": "harbor",
        "version": "2.0.0",
    }
    s = await content.create_item(db, who, "site", {"title": "Boats", "tagline": "Built by hand.", "theme": "harbor"}, None)  # fmt: skip
    assert "HARBOR" not in (await http.get("/")).text
    req = await approvals.request(db, who, [s["id"]], "")
    await approvals.decide(db, req["id"], {s["id"]: {"decision": "approve"}}, "")
    r = await http.get("/")
    assert r.text == "HARBOR Built by hand."
    assert "fonts.googleapis.com" in r.headers["content-security-policy"]
    # Its stylesheet carries the site's palette after the theme's own rules.
    css = await http.get("/static/site.css")
    assert css.status_code == 200
    assert css.headers["cache-control"] == "public, max-age=3600"
    assert (await http.get("/static/nothing.css")).status_code == 404
