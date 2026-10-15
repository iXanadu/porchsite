"""A deliberately incomplete look: port of stage-one-check.test.ts."""
import json

from server.app import content, oauth, themes

from .web import Mcp, publish


async def test_reports_the_published_entry_a_rendered_look_drops_excluding_drafts(db, http):
    who = "assistant:test"
    s = await content.create_item(db, who, "site", {"title": "Test", "theme": "dropped-entry", "sections": ["entries"]}, None)
    visible = await content.create_item(db, who, "entry", {"title": "Visible", "date": "2026-10-10", "slug": "visible", "status": "ready"}, None)
    hidden = await content.create_item(db, who, "entry", {"title": "Hidden", "date": "2026-10-09", "slug": "hidden", "status": "ready"}, None)
    draft = await content.create_item(db, who, "entry", {"title": "Draft", "date": "2026-10-08", "status": "draft"}, None)
    base = themes.built_in()["product-page"]
    look = {**base, "manifest": {**base["manifest"], "name": "dropped-entry"}, "pages": {**base["pages"], "home": '<html><body><a href="/journal/visible/">{{site.title}}</a></body></html>', "entry": '<html><body><a href="/">{{site.title}}</a></body></html>'}}
    # Bypass the quality gate only to install the intentionally broken fixture.
    await db.execute("INSERT INTO themes (name, version, package, sha256, installed_at, installed_by, source) VALUES ($1, $2, $3, $4, $5, $6, 'private')", "dropped-entry", "1.0.0", json.dumps(look), "fixture", "2026-10-15", who)
    await publish(db, [s["id"], visible["id"], hidden["id"]])
    home = (await http.get("/")).text
    assert 'href="/journal/visible/"' in home
    assert "/journal/hidden/" not in home
    visible_page = (await http.get("/journal/visible/")).text
    assert 'href="/"' in visible_page
    assert 'href="/journal/"' not in visible_page
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, result, _ = await a.call("site_check")
    assert not err
    assert result["ok"] is False
    assert [x["id"] for x in result["unreachable"]] == [hidden["id"]]
    assert isinstance(result["unreachable"][0]["why"], str)
    assert result["unreachable"][0]["why"]
