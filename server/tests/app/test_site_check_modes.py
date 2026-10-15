from server.app import oauth, themes

from .web import Mcp


async def test_default_skips_look_loading_and_validates_deep(db, http, monkeypatch):
    assistant = Mcp(http, await oauth.mint(db, "Fixture", "https://site.example"))
    err, deep, _ = await assistant.call("site_check", deep=True)
    assert not err
    assert deep["unreachable"] == []

    async def refuse(*args, **kwargs):
        raise AssertionError("quick must not load a look")

    monkeypatch.setattr(themes, "load", refuse)
    for args in ({}, {"deep": False}, {"unknown": True}):
        err, result, _ = await assistant.call("site_check", **args)
        assert not err
        assert result == {"ok": True, "broken": [], "empty_sections": ["Updates (journal)", "cards", "notes", "about"]}
    for deep in (None, "true", 1, [], {}):
        err, text, _ = await assistant.call("site_check", deep=deep)
        assert err
        assert "deep: Invalid input: expected boolean" in text
