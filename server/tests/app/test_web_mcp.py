"""The assistant's tools through the real /mcp endpoint, with a token minted
by the admin CLI's code (oauth.mint). Port of the tool behaviour of
cloudflare/src/mcp.ts; the tool list must be the Cloudflare edition's
(cloudflare_tools.json, from server/scripts/cloudflare-contract.sh)."""

import json
from pathlib import Path

from server.app import mcp, oauth
from server.spec.models import MODELS

from .web import MCP_HEADERS, Mcp

CF = json.loads(Path(__file__).with_name("cloudflare_tools.json").read_text(encoding="utf-8"))


async def assistant(db, http, client="Helper", origin="https://site.example"):
    return Mcp(http, await oauth.mint(db, client, origin))


async def test_lists_the_cloudflare_editions_tools_exactly(db, http):
    a = await assistant(db, http)
    init = (await a.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}))["result"]  # fmt: skip
    assert init["serverInfo"]["name"] == "porchsite"
    assert init["serverInfo"]["version"] == "0.0.1"
    assert init["instructions"] == CF["instructions"] == mcp.INSTRUCTIONS
    assert init["capabilities"]["tools"]["listChanged"] is True
    tools = (await a.rpc("tools/list"))["result"]["tools"]
    assert tools == CF["tools"]


async def test_refuses_without_a_token_and_with_another_sites(db, http):
    anon = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers=MCP_HEADERS)  # fmt: skip
    assert anon.status_code == 401
    assert (
        'resource_metadata="https://site.example/.well-known/oauth-protected-resource/mcp"'
        in anon.headers["www-authenticate"]
    )
    elsewhere = await oauth.mint(db, "Helper", "https://other.example")
    r = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers={**MCP_HEADERS, "authorization": f"Bearer {elsewhere}"})  # fmt: skip
    assert r.status_code == 401
    assert r.json()["error"] == "invalid_token"
    assert 'error="invalid_token"' in r.headers["www-authenticate"]
    bogus = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers={**MCP_HEADERS, "authorization": "Bearer owner:x:y"})  # fmt: skip
    assert bogus.status_code == 401
    # An expired token is refused too.
    old = await oauth.mint(db, "Helper", "https://site.example", ttl=-1)
    gone = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers={**MCP_HEADERS, "authorization": f"Bearer {old}"})  # fmt: skip
    assert gone.status_code == 401


async def test_the_workflow_from_site_state_to_approval(db, http):
    a = await assistant(db, http)
    err, state, res = await a.call("site_state")
    assert not err
    assert res["structuredContent"] == state
    assert state["release"] == "test"
    assert state["items"] == []
    assert set(state["states"]) == {"live", "changed", "new", "removal staged", "removed"}
    assert set(state["kinds"]) == set(MODELS)
    assert set(state["fields"]["site"]) == set(MODELS["site"].model_fields)
    assert state["site_defaults"]["theme"] == "built-in"

    entry = {"title": "Hull done", "date": "2026-10-08", "summary": "Planked."}
    err, made, _ = await a.call("item_create", kind="entry", data=entry, idempotency_key="k1")
    assert not err
    assert (made["state"], made["live_version"], made["pending_approval"], made["last_approval"]) == ("new", None, None, None)  # fmt: skip
    assert made["next"] == mcp.NEXT
    assert "replayed" not in made
    err, again, _ = await a.call("item_create", kind="entry", data=entry, idempotency_key="k1")
    assert again["id"] == made["id"] and again["replayed"] is True

    err, stale, res = await a.call("item_update", id=made["id"], version=7, data={"summary": "x"})
    assert err and stale["error"] == "version_conflict" and stale["current_version"] == 1
    assert "structuredContent" not in res or res["structuredContent"] is None
    err, guarded, _ = await a.call("item_create", kind="entry", data={**entry, "title": "Guard", "body": "password: hunter2xyz"})  # fmt: skip
    assert err and guarded["error"] == "content_guard"

    err, upd, _ = await a.call("item_update", id=made["id"], version=1, data={"summary": "Planked and painted."}, reason="more")  # fmt: skip
    assert not err and upd["version"] == 2
    err, hist, _ = await a.call("item_history", id=made["id"])
    assert [v["version"] for v in hist["versions"]] == [2, 1]
    assert hist["versions"][0]["actor"] == "assistant:Helper"
    err, rb, _ = await a.call("item_rollback", id=made["id"], to_version=1, version=2)
    assert not err and rb["version"] == 3

    err, req, _ = await a.call("approval_request", ids=[made["id"]], note="the hull")
    assert not err
    assert req["review_url"] == f"https://site.example/review/{req['id']}"
    err, st, _ = await a.call("approval_status", approval_id=req["id"])
    assert st["items"][0]["status"] == "pending"
    err, listed, _ = await a.call("approval_status")
    assert [x["id"] for x in listed["approvals"]] == [req["id"]]
    err, state, _ = await a.call("site_state")
    item = next(i for i in state["items"] if i["id"] == made["id"])
    assert item["pending_approval"] == req["id"]
    assert item["last_approval"] == {"id": req["id"], "status": "pending", "note": ""}

    # Editing after asking voids the request for that item.
    await a.call("item_update", id=made["id"], version=3, data={"summary": "Again."})
    err, st, _ = await a.call("approval_status", approval_id=req["id"])
    assert st["items"][0]["status"] == "superseded"
    err, gone, _ = await a.call("item_remove", id=made["id"], version=4, reason="cleanup")
    assert not err and gone["state"] == "removed"

    # Nothing an assistant did reached the public site.
    assert "Hull done" not in (await http.get("/")).text


async def test_arguments_are_checked_as_zod_checks_them(db, http):
    a = await assistant(db, http)
    err, text, _ = await a.call("item_update", id=5)
    assert err
    assert text == "Input validation error: Invalid arguments for tool item_update: id: Invalid input: expected string, received number, version: Invalid input: expected number, received undefined, data: Invalid input: expected record, received undefined"  # fmt: skip
    err, text, _ = await a.call("item_create", kind="page", data={})
    assert text == 'Input validation error: Invalid arguments for tool item_create: kind: Invalid option: expected one of "site"|"entry"|"card"|"note"'  # fmt: skip
    err, text, _ = await a.call("approval_request", ids=[])
    assert text == "Input validation error: Invalid arguments for tool approval_request: ids: Too small: expected array to have >=1 items"  # fmt: skip
    err, text, _ = await a.call("theme_install", name="Bad Name")
    assert text == "Input validation error: Invalid arguments for tool theme_install: name: Invalid string: must match pattern /^[a-z][a-z0-9-]{0,39}$/"  # fmt: skip
    unknown = await a.rpc("tools/call", {"name": "publish_now", "arguments": {}})
    assert "error" in unknown or unknown["result"].get("isError")


async def test_photo_links_and_themes(db, http):
    a = await assistant(db, http)
    err, link, _ = await a.call("photo_upload_link", purpose="the cover")
    assert not err
    assert link["url"].startswith("https://site.example/upload/")
    assert (link["status"], link["purpose"], link["image"]) == ("waiting", "the cover", None)
    assert "path" not in link
    path = link["url"].removeprefix("https://site.example")
    png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 3])  # fmt: skip
    sent = await http.post(path, files={"photo": ("p.png", png, "image/png")}, data={"alt": "A hull"}, headers={"accept": "application/json"})  # fmt: skip
    assert sent.status_code == 200 and sent.json()["status"] == "done"
    err, status, _ = await a.call("photo_upload_status", id=link["id"])
    assert status["status"] == "done" and status["image"].startswith("/media/")

    err, needs, _ = await a.call("theme_needs", name="product-page")
    assert not err and needs["theme"] == "product-page"
    err, none, _ = await a.call("theme_needs", name="nope")
    assert err and none["error"] == "no_such_theme"


async def test_site_stats_through_the_tool(db, http):
    a = await assistant(db, http)
    err, s, _ = await a.call("site_stats")
    assert not err
    assert s["totals"]["visits"] == 0
    assert s["filter"] == {"content_id": None, "src": None, "post": None, "include_test": False}
    assert s["range"]["start"] < s["range"]["end"]
    err, text, _ = await a.call("site_stats", days=0, include_test="yes")
    assert err
    assert text == (
        "Input validation error: Invalid arguments for tool site_stats: "
        "days: Too small: expected number to be >=1, "
        "include_test: Invalid input: expected boolean, received string"
    )
