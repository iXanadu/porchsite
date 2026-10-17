"""MCP's exact Origin boundary, paired with the Worker fixtures."""

import json
from dataclasses import replace
from pathlib import Path

import pytest

from server.app import keys, oauth

from .web import MCP_HEADERS

CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "spec/fixtures/mcp-origins.json").read_text()
)
BODY = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}


@pytest.mark.parametrize("row", CASES, ids=lambda row: row["name"])
async def test_mcp_origin_boundary(db, http, row):
    key = await keys.create(db, "Origin test")
    headers = {**MCP_HEADERS, "Authorization": f"Bearer {key['token']}"}
    if row["origin"] is not None:
        headers["Origin"] = row["origin"]
    response = await http.post("/mcp", json=BODY, headers=headers)
    assert response.status_code == row["status"], response.text
    if row["status"] == 200:
        assert len(response.json()["result"]["tools"]) > 10
    else:
        assert response.text == "Invalid Origin header"


async def test_oauth_token_uses_same_origin_boundary(db, http):
    token = await oauth.mint(db, "Origin test", "https://site.example")
    for origin, status in (
        (None, 200),
        ("https://SITE.EXAMPLE", 200),
        ("https://other.example", 403),
    ):
        headers = {**MCP_HEADERS, "Authorization": f"Bearer {token}"}
        if origin is not None:
            headers["Origin"] = origin
        assert (await http.post("/mcp", json=BODY, headers=headers)).status_code == status


async def test_configured_origin_www_redirect_and_auth(db, app, http):
    key = await keys.create(db, "Origin test")
    headers = {**MCP_HEADERS, "Authorization": f"Bearer {key['token']}"}
    app.settings = replace(app.settings, site_url="https://www.canonical.example:8443/")
    for origin, status in (
        ("https://canonical.example:8443", 200),
        ("https://CANONICAL.EXAMPLE:8443", 200),
        ("https://site.example", 403),
        ("https://canonical.example", 403),
    ):
        assert (
            await http.post("/mcp", json=BODY, headers={**headers, "Origin": origin})
        ).status_code == status
    app.settings = replace(app.settings, site_url="")
    bare = "https://site.example/mcp"
    response = await http.post(
        "https://www.site.example/mcp",
        json=BODY,
        headers={**headers, "Origin": "https://site.example"},
    )
    assert response.status_code == 301 and response.headers["Location"] == bare
    assert (
        await http.post(bare, json=BODY, headers={**headers, "Origin": "https://site.example"})
    ).status_code == 200
    assert (
        await http.post(
            "/mcp",
            json=BODY,
            headers={
                **MCP_HEADERS,
                "Authorization": "Bearer psk_invalid",
                "Origin": "https://site.example",
            },
        )
    ).status_code == 401


async def test_foreign_origin_methods_and_duplicate_origins(db, http):
    key = await keys.create(db, "Origin test")
    for method in ("GET", "HEAD", "OPTIONS", "POST"):
        response = await http.request(
            method,
            "/mcp",
            headers={"Authorization": f"Bearer {key['token']}", "Origin": "https://other.example"},
        )
        assert response.status_code == 403
    assert (
        await http.options("/mcp", headers={"Origin": "https://site.example"})
    ).status_code == 204
    response = await http.post(
        "/mcp",
        json=BODY,
        headers=[
            *MCP_HEADERS.items(),
            ("Authorization", f"Bearer {key['token']}"),
            ("Origin", "https://site.example"),
            ("Origin", "https://other.example"),
        ],
    )
    assert response.status_code == 403


async def test_oauth_routes_keep_their_existing_origin_behaviour(http):
    for path in ("/authorize", "/oauth/token", "/oauth/register"):
        method = "GET" if path == "/authorize" else "POST"
        baseline = await http.request(method, path, json={} if method == "POST" else None)
        foreign = await http.request(
            method,
            path,
            json={} if method == "POST" else None,
            headers={"Origin": "https://other.example"},
        )
        assert foreign.status_code == baseline.status_code
        assert "Invalid Origin" not in foreign.text
        assert foreign.headers.get("Access-Control-Allow-Origin") == baseline.headers.get(
            "Access-Control-Allow-Origin"
        )
