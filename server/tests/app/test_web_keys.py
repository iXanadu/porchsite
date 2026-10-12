"""Assistant keys (SPEC §4): the owner makes one on /review/assistants; an
assistant sends it to /mcp as a bearer token and drafts like any other;
revoked, it stops working. Port of cloudflare/test/keys.test.ts."""

import re

from server.app import content

from .web import MCP_HEADERS, Mcp, signed_in


async def test_a_key_drafts_like_a_connected_assistant_until_revoked(db, http):
    cookies = await signed_in(db)
    page = (await http.get("/review/assistants", cookies=cookies)).text
    assert '<h1 style="margin-top:36px">Assistant keys</h1>' in page
    csrf = re.search(r'name="csrf" value="([^"]+)"', page).group(1)
    made = (await http.post("/review/assistants", data={"csrf": csrf, "key_name": "Muse", "make_key": "1"}, cookies=cookies)).text  # fmt: skip
    key = re.search(r'<p class="value"><b>(psk_[A-Za-z0-9_-]+)</b>', made).group(1)
    assert "Copy it now" in made and "made " in made

    a = Mcp(http, key)
    init = await a.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})  # fmt: skip
    assert init["result"]["serverInfo"]["name"] == "sitekeeper"
    err, item, _ = await a.call("item_create", kind="note", data={"text": "Hello from a key.", "date": "2026-10-12"})  # fmt: skip
    assert not err
    hist = await content.history(db, item["id"])
    assert hist[0]["actor"] == "assistant:Muse"

    page = (await http.get("/review/assistants", cookies=cookies)).text
    assert "last used " in page
    kid = re.search(r'name="revoke_key" value="([^"]+)"', page).group(1)
    await http.post("/review/assistants", data={"csrf": csrf, "revoke_key": kid}, cookies=cookies)
    refused = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 9, "method": "tools/list"}, headers={**MCP_HEADERS, "authorization": f"Bearer {key}"})  # fmt: skip
    assert refused.status_code == 401
    assert refused.json()["error"] == "invalid_token"
    wrong = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 9, "method": "tools/list"}, headers={**MCP_HEADERS, "authorization": "Bearer psk_nope"})  # fmt: skip
    assert wrong.status_code == 401
