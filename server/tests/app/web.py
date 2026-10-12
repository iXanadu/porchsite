"""Helpers for the web app's tests: publishing as the owner would, signing in
as the Cloudflare tests do (an owner row and a session row, no
authenticator), and calling /mcp."""

import base64
import hashlib
import json

from server.app import approvals

who = "assistant:test"


async def publish(db, ids):
    req = await approvals.request(db, who, ids, "")
    await approvals.decide(db, req["id"], {i: {"decision": "approve"} for i in ids}, "")


def session_hash(token: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode().rstrip("=")


async def claimed(db, handle: str = "AAAAAAAAAAAAAAAAAAAAAA"):
    await db.execute(
        "INSERT INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', $1, '2026-10-10')"
        " ON CONFLICT DO NOTHING",
        handle,
    )


async def signed_in(db, token: str = "test-session-token") -> dict[str, str]:
    """Cookies of a signed-in owner."""
    await claimed(db)
    await db.execute(
        "INSERT INTO sessions (token_hash, created_at, expires_at) VALUES ($1, '2026-10-10', '2099-01-01')"
        " ON CONFLICT (token_hash) DO UPDATE SET expires_at = excluded.expires_at",
        session_hash(token),
    )
    return {"__Host-sk_owner": token}


MCP_HEADERS = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
}


class Mcp:
    """An assistant on /mcp with an access token."""

    def __init__(self, http, token: str):
        self.http = http
        self.headers = {**MCP_HEADERS, "authorization": f"Bearer {token}"}
        self.n = 0

    async def rpc(self, method: str, params: dict | None = None):
        self.n += 1
        r = await self.http.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}},
            headers=self.headers,
        )
        assert r.status_code == 200, r.text
        return r.json()

    async def call(self, tool: str, **args):
        """(is_error, payload, result)"""
        res = (await self.rpc("tools/call", {"name": tool, "arguments": args}))["result"]
        text = res["content"][0]["text"]
        try:
            payload = json.loads(text)
        except ValueError:
            payload = text
        return bool(res.get("isError")), payload, res
