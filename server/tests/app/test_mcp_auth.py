"""Paired MCP authentication refusal matrix (SPEC §4, PAR-1)."""
import json
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock

from server.app import keys, read_keys, oauth
from .web import MCP_HEADERS

ROWS = json.loads((Path(__file__).resolve().parents[3] / "spec/fixtures/mcp-auth-refusals.json").read_text())
BODY = {"jsonrpc":"2.0","id":1,"method":"tools/list"}
ORIGIN = "https://site.example"


def refusal(response, invalid, origin=ORIGIN):
    assert response.status_code == 401, response.text
    suffix = ', error="invalid_token"' if invalid else ""
    assert response.headers["www-authenticate"] == f'Bearer realm="OAuth", resource_metadata="{origin}/.well-known/oauth-protected-resource/mcp"{suffix}, scope="site:draft"'
    assert response.headers["cache-control"] == "private, no-store, no-transform"
    assert "www-authenticate" in [s.strip().lower() for s in response.headers["access-control-expose-headers"].split(",")]
    assert response.headers["access-control-allow-origin"] == "*"
    for name in ("etag","last-modified","age","location"):
        assert name not in response.headers


async def test_mcp_auth_refusal_headers_shared_raw_matrix(db, app, http, monkeypatch):
    dispatch = AsyncMock(side_effect=AssertionError("unexpected tool dispatch"))
    monkeypatch.setattr(app.sessions, "handle_request", dispatch)
    monkeypatch.setattr(app.read_sessions, "handle_request", dispatch)
    fetch = AsyncMock(side_effect=AssertionError("unexpected metadata fetch"))
    monkeypatch.setattr(oauth, "capped_public_fetch", fetch)
    before = await db.fetchval("SELECT COUNT(*) FROM items")
    for origin in (ORIGIN,"https://canonical.example:8443"):
        app.settings = replace(app.settings,site_url="" if origin == ORIGIN else origin)
        for row in ROWS:
            headers = dict(MCP_HEADERS)
            if row["authorization"] is not None:
                headers["Authorization"] = row["authorization"]
            response = await http.post("/mcp",headers=headers,json=BODY)
            refusal(response,row["invalid"],origin)
            if row["invalid"]:
                assert response.json()["error"] == "invalid_token"
            else:
                assert response.content == b""
    dispatch.assert_not_awaited()
    fetch.assert_not_awaited()
    assert await db.fetchval("SELECT COUNT(*) FROM items") == before


async def test_mcp_auth_refusal_headers_key_authority_expiry_revocation(db,http):
    for api,table in ((keys,"assistant_keys"),(read_keys,"agent_read_keys")):
        key = await api.create(db,"Header test")
        headers = {**MCP_HEADERS,"Authorization":"Bearer "+key["token"]}
        good = await http.post("/mcp",headers=headers,json=BODY)
        assert good.status_code == 200
        assert "www-authenticate" not in good.headers
        count = len(good.json()["result"]["tools"])
        assert count == 5 if table == "agent_read_keys" else count > 10
        await db.execute(f"UPDATE {table} SET expires_at='2000-01-01' WHERE id=$1",key["id"])
        refusal(await http.post("/mcp",headers=headers,json=BODY),True)
        await db.execute(f"UPDATE {table} SET expires_at='2099-01-01',revoked_at='2026-10-18' WHERE id=$1",key["id"])
        refusal(await http.post("/mcp",headers=headers,json=BODY),True)


async def test_mcp_auth_refusal_headers_oauth_expiry_revocation(db,http):
    token = await oauth.mint(db,"Header test",ORIGIN)
    headers = {**MCP_HEADERS,"Authorization":"Bearer "+token}
    assert (await http.post("/mcp",headers=headers,json=BODY)).status_code == 200
    await db.execute("UPDATE oauth_tokens SET expires_at=1 WHERE token_hash=$1",oauth._hash(token))
    refusal(await http.post("/mcp",headers=headers,json=BODY),True)
    await db.execute("DELETE FROM oauth_tokens WHERE token_hash=$1",oauth._hash(token))
    refusal(await http.post("/mcp",headers=headers,json=BODY),True)


async def test_mcp_auth_refusal_headers_origin_and_options(http):
    for method in ("POST","OPTIONS"):
        response = await http.request(method,"/mcp",headers={**MCP_HEADERS,"Authorization":"Bearer prk_invalid","Origin":"https://other.example"},json=BODY if method == "POST" else None)
        assert response.status_code == 403
        assert "www-authenticate" not in response.headers
    for auth in (None,"Bearer prk_invalid"):
        headers = dict(MCP_HEADERS)
        if auth is not None:
            headers["Authorization"] = auth
        response = await http.options("/mcp",headers=headers)
        assert response.status_code == 204
        assert "www-authenticate" not in response.headers


async def test_mcp_auth_preflight_identity_no_storage_or_credential_oracle(db,app,http,monkeypatch):
    expected = json.loads((Path(__file__).resolve().parents[3] / "spec/fixtures/mcp-preflight.json").read_text())
    credentials = [None,"Bearer psk_invalid","Bearer prk_invalid","Bearer owner:missing:token","Bearer one two"]
    for api,table in ((keys,"assistant_keys"),(read_keys,"agent_read_keys")):
        for state in ("valid","expired","revoked"):
            made = await api.create(db,"Preflight")
            if state == "expired":
                await db.execute(f"UPDATE {table} SET expires_at='2000-01-01' WHERE id=$1",made["id"])
            if state == "revoked":
                await api.revoke(db,made["id"])
            credentials.append("Bearer "+made["token"])
    for state in ("valid","expired","revoked"):
        token = await oauth.mint(db,"Preflight",ORIGIN,ttl=-1 if state == "expired" else 3600)
        if state == "revoked":
            await db.execute("DELETE FROM oauth_tokens WHERE token_hash=$1",oauth._hash(token))
        credentials.append("Bearer "+token)
    app.settings = replace(app.settings,release="dev")
    class NoStorage:
        def __getattr__(self,name):
            raise AssertionError("preflight touched storage")
    monkeypatch.setattr(app,"_pool",NoStorage())
    for auth in credentials:
        headers = {} if auth is None else {"Authorization":auth}
        response = await http.options("/mcp",headers=headers)
        assert response.status_code == expected["status"]
        assert "content-length" not in response.headers
        assert response.text == expected["body"]
        assert dict(response.headers) == {**expected["headers"],"x-porchsite-release":"dev"}
