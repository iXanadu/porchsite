"""SP-S3 paired with cloudflare/test/site-guide.test.ts."""

import copy
import hashlib
import json

import pytest_asyncio

from server.app import approvals, content, keys, oauth
from server.app.site_guide import GUIDE_KEYS, GUIDE_REVISION, fixed_guide

from .conftest import TABLES
from .web import MCP_HEADERS, Mcp

ORIGIN = "https://site.example"


@pytest_asyncio.fixture(autouse=True)
async def clean(db):
    await db.execute(f"TRUNCATE {TABLES} RESTART IDENTITY")
    await db.execute("UPDATE auth_state SET private_floor='',owner_epoch=0 WHERE id=1")


async def assistant(db, http):
    made = await keys.create(db, "Fixture")
    return Mcp(http, made["token"]), made


async def test_site_state_guide_default_compat(db, http):
    a, _ = await assistant(db, http)
    for args in [{}, {"full": True}, {"ids": []}]:
        err, before, old_result = await a.call("site_state", **args)
        e, first, _ = await a.call("site_state", **args, guide={})
        assert not err and not e and "guide" not in before
        metadata = first.pop("guide")
        assert (
            json.dumps(first, ensure_ascii=False, separators=(",", ":"))
            == old_result["content"][0]["text"]
        )
        assert metadata == {"revision": GUIDE_REVISION, "included": True}

    sizes = {}
    for label, guide_args in [
        ("default", {}),
        ("first", {"guide": {}}),
        ("compact", {"guide": {"known_revision": GUIDE_REVISION}}),
    ]:
        response = await http.post(
            "/mcp",
            headers=a.headers,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "site_state", "arguments": {"ids": [], **guide_args}},
            },
        )
        text = response.json()["result"]["content"][0]["text"]
        sizes[label] = {"contentBytes": len(text.encode()), "rpcBytes": len(response.content)}
    print("GUIDE_MEASUREMENT " + json.dumps(sizes))


async def test_site_state_guide_conditional(db, http):
    a, _ = await assistant(db, http)
    _, first, _ = await a.call("site_state", guide={})
    for known in [GUIDE_REVISION, "older-guide", "ssg2:future"]:
        err, value, _ = await a.call("site_state", guide={"known_revision": known})
        assert not err
        assert value["guide"] == {"revision": GUIDE_REVISION, "included": known != GUIDE_REVISION}
        assert all((key in value) == (known != GUIDE_REVISION) for key in GUIDE_KEYS)
        assert value["items"] == first["items"] and value["update"] == first["update"]
    for guide in [
        None,
        True,
        [],
        {"unknown": 1},
        {"known_revision": None},
        {"known_revision": 1},
        {"known_revision": ""},
        {"known_revision": "x" * 129},
        {"known_revision": "token\n"},
        {"known_revision": "https://example.com"},
        {"known_revision": "é"},
    ]:
        err, value, result = await a.call("site_state", guide=guide)
        assert err and isinstance(value, str), guide
        assert (
            not result.get("structuredContent")
            and GUIDE_REVISION not in result["content"][0]["text"]
        )


async def test_site_state_guide_fresh_state(db, http):
    a, _ = await assistant(db, http)
    who = "assistant:Fixture"
    item = await content.create_item(
        db, who, "note", {"text": "Before", "date": "2026-10-17"}, None
    )
    args = {"ids": [item["id"]], "guide": {"known_revision": GUIDE_REVISION}}
    _, state, _ = await a.call("site_state", **args)
    assert state["items"][0]["version"] == 1
    await content.update_item(db, who, item["id"], 1, {"text": "After"})
    approval = await approvals.request(db, who, [item["id"]], "")
    _, state, _ = await a.call("site_state", **args)
    assert state["items"][0]["data"]["text"] == "After"
    assert state["items"][0]["pending_approval"] == approval["id"]
    await approvals.decide(db, approval["id"], {item["id"]: {"decision": "approve"}}, "")
    _, state, _ = await a.call("site_state", **args)
    assert state["items"][0]["state"] == "live" and state["items"][0]["version"] == 2
    await content.remove_item(db, who, item["id"], 2)
    _, state, _ = await a.call("site_state", **args)
    assert state["items"][0]["state"] == "removal staged"
    _, empty, _ = await a.call("site_state", ids=[], guide={"known_revision": GUIDE_REVISION})
    assert empty["items"] == []
    err, value, result = await a.call(
        "site_state", ids=["missing"], guide={"known_revision": GUIDE_REVISION}
    )
    assert err and value["error"] == "no_such_item" and "guide" not in value
    assert not result.get("structuredContent")


async def test_site_state_guide_access(db, http):
    a, made = await assistant(db, http)
    site = await content.create_item(
        db, "assistant:Fixture", "site", {"title": "Private", "private": True}, None
    )
    approval = await approvals.request(db, "assistant:Fixture", [site["id"]], "")
    await approvals.decide(db, approval["id"], {site["id"]: {"decision": "approve"}}, "")
    _, state, _ = await a.call("site_state", guide={})
    assert state["guide"]["included"]
    oauth_client = Mcp(http, await oauth.mint(db, "Fixture", ORIGIN))
    err, state, _ = await oauth_client.call("site_state", ids=[], guide={})
    assert not err and state["guide"]["revision"] == GUIDE_REVISION
    for invalid in ["", GUIDE_REVISION, "psk_missing"]:
        response = await http.post(
            "/mcp",
            headers={**MCP_HEADERS, "Authorization": f"Bearer {invalid}"},
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "site_state", "arguments": {"guide": {"unknown": 1}}},
            },
        )
        assert response.status_code == 401 and GUIDE_REVISION not in response.text
    await keys.revoke(db, made["id"])
    response = await http.post(
        "/mcp",
        headers=a.headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "site_state",
                "arguments": {"guide": {"known_revision": GUIDE_REVISION}},
            },
        },
    )
    assert response.status_code == 401
    for path in ["/", "/site-state-guide.json", "/.well-known/site-state-guide"]:
        response = await http.get(path)
        assert response.status_code == 404 and GUIDE_REVISION not in response.text


def revision(guide):
    body = json.dumps(
        {"format": 1, "guide": guide}, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    ).encode()
    return "ssg1-sha256-" + hashlib.sha256(body).hexdigest()


async def test_site_state_guide_revision_parity():
    assert revision(fixed_guide()) == GUIDE_REVISION
    for key in GUIDE_KEYS:
        guide = copy.deepcopy(fixed_guide())
        guide[key]["revision_test"] = "changed"
        assert revision(guide) != GUIDE_REVISION


async def test_site_state_guide_rollback(db, http):
    a, _ = await assistant(db, http)
    _, first, _ = await a.call("site_state", ids=[], guide={})
    _, second, _ = await a.call(
        "site_state", ids=[], guide={"known_revision": first["guide"]["revision"]}
    )
    assert not second["guide"]["included"]
    assert (await a.call("site_state", ids=[], guide={}))[1]["guide"]["included"]
    assert (
        await a.call("site_state", ids=[], guide={"known_revision": "rollback-older-revision"})
    )[1]["guide"]["included"]
    assert "guide" not in (await a.call("site_state"))[1]
