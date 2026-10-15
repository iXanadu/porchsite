"""Inline feature reachability: port of stage-one-inline.test.ts."""
import json

from server.app import content, oauth, themes

from .web import Mcp, publish


async def test_counts_full_inline_feature_body_but_not_a_title_or_summary_alone(db, http):
    who = "assistant:test"
    s = await content.create_item(db, who, "site", {"title": "Test", "theme": "product-page", "streams": [{"id": "front", "title": "Overview", "layout": "feature"}], "sections": ["front"]}, None)
    feature = await content.create_item(db, who, "entry", {"title": "Feature", "summary": "Short summary", "body": "The complete inline feature body.", "stream": "front", "slug": "overview", "date": "2026-10-15", "status": "ready"}, None)
    await publish(db, [s["id"], feature["id"]])
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    home = (await http.get("/")).text
    assert "The complete inline feature body." in home
    assert 'href="/front/overview/"' not in home
    assert "porchsite-check-" not in home
    err, inline, _ = await a.call("site_check", deep=True)
    assert not err
    assert inline["ok"] is True
    assert inline["unreachable"] == []
    home_after_check = (await http.get("/")).text
    assert home_after_check == home
    assert "porchsite-check-" not in home_after_check

    base = themes.built_in()["product-page"]
    look = {**base, "manifest": {**base["manifest"], "name": "summary-only"}, "pages": {**base["pages"], "home": '<html><body>{{#sections}}{{#latest}}<h1>{{title}}</h1><p>{{summary}}</p>{{/latest}}{{/sections}}</body></html>'}}
    await db.execute("INSERT INTO themes (name, version, package, sha256, installed_at, installed_by, source) VALUES ($1, $2, $3, $4, $5, $6, 'private')", "summary-only", "1.0.0", json.dumps(look), "fixture", "2026-10-15", who)
    await content.update_item(db, who, s["id"], 1, {"theme": "summary-only"})
    await publish(db, [s["id"]])
    summary_home = (await http.get("/")).text
    assert "Short summary" in summary_home
    assert "The complete inline feature body." not in summary_home
    err, omitted, _ = await a.call("site_check", deep=True)
    assert not err
    assert omitted["ok"] is False
    assert [x["id"] for x in omitted["unreachable"]] == [feature["id"]]
