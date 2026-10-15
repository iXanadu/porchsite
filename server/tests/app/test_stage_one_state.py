"""site_state summary/full/ids: port of stage-one-state.test.ts."""
from server.app import oauth

from .web import Mcp


async def test_returns_a_summary_by_default_and_preserves_full_item_metadata(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, made, _ = await a.call("item_create", kind="entry", data={"title": "Summary target", "date": "2026-10-15", "body": "Full body text"})
    assert not err
    err, summary, _ = await a.call("site_state")
    assert not err
    item = next(x for x in summary["items"] if x["id"] == made["id"])
    assert item == {"id": made["id"], "kind": "entry", "title": "Summary target", "state": "new", "version": 1}
    err, full, _ = await a.call("site_state", full=True)
    assert not err
    expanded = next(x for x in full["items"] if x["id"] == made["id"])
    assert expanded == {k: v for k, v in made.items() if k != "next"}
    assert full["release"] == summary["release"]
    assert full["update"] == summary["update"]


async def test_returns_full_data_only_for_requested_ids(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, first, _ = await a.call("item_create", kind="note", data={"text": "Selected note", "date": "2026-10-15"})
    assert not err
    err, _, _ = await a.call("item_create", kind="note", data={"text": "Other note", "date": "2026-10-15"})
    assert not err
    err, result, _ = await a.call("site_state", ids=[first["id"]])
    assert not err
    assert [x["id"] for x in result["items"]] == [first["id"]]
    assert result["items"][0]["data"]["text"] == "Selected note"
    assert result["items"][0]["pending_approval"] is None


async def test_refuses_an_unknown_id_instead_of_silently_returning_unrelated_items(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, result, _ = await a.call("site_state", ids=["ent_missing"])
    assert err
    assert result["error"] == "no_such_item"


async def test_empty_duplicate_ids_precedence_and_mixed_unknown_selection(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, first, _ = await a.call("item_create", kind="card", data={"name": "A card", "description": "A description"})
    assert not err
    err, empty, _ = await a.call("site_state", full=True, ids=[])
    assert not err and empty["items"] == []
    err, selected, _ = await a.call("site_state", full=True, ids=[first["id"], first["id"]])
    assert not err and len(selected["items"]) == 1
    assert selected["items"][0]["data"]["name"] == "A card"
    err, unknown, _ = await a.call("site_state", ids=[first["id"], "missing"])
    assert err and unknown["error"] == "no_such_item"
    err, summary, _ = await a.call("site_state")
    assert not err
    assert next(x for x in summary["items"] if x["id"] == first["id"]) == {"id": first["id"], "kind": "card", "title": "A card", "state": "new", "version": 1}
