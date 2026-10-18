"""OAuth protocol 204 framing; paired with the Worker path fixture."""
import json
from pathlib import Path
from unittest.mock import AsyncMock
from server.app import oauth

PATHS = json.loads((Path(__file__).resolve().parents[3]/"spec/fixtures/oauth-preflight-paths.json").read_text())

async def test_oauth_preflight_framing_all_paths_no_storage_or_fetch(app,http,monkeypatch):
    class NoStorage:
        def __getattr__(self,name):
            raise AssertionError("OAuth preflight touched storage")
    monkeypatch.setattr(app,"_pool",NoStorage())
    fetch = AsyncMock(side_effect=AssertionError("unexpected metadata fetch"))
    monkeypatch.setattr(oauth,"capped_public_fetch",fetch)
    dispatch = AsyncMock(side_effect=AssertionError("unexpected MCP dispatch"))
    monkeypatch.setattr(app.sessions,"handle_request",dispatch)
    for path in PATHS:
        for origin in (None,"https://site.example","https://other.example"):
            baseline = None
            for auth in (None,"Bearer psk_invalid","Bearer prk_invalid","Bearer owner:missing:token","Basic unused"):
                headers = {}
                if origin:headers["Origin"] = origin
                if auth:headers["Authorization"] = auth
                response = await http.options(path,headers=headers)
                assert response.status_code == 204, path
                assert response.content == b""
                for name in ("content-length","www-authenticate","set-cookie","etag","location"):
                    assert name not in response.headers, (path,name)
                current = dict(response.headers)
                if baseline is not None:assert current == baseline
                else:baseline = current
    fetch.assert_not_awaited()
    dispatch.assert_not_awaited()
