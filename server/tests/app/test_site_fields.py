"""Paired with the native Worker site-fields tests."""

import json
from copy import deepcopy
from pathlib import Path

import pytest

from server.app import approvals, content, history, oauth
from server.app.errors import ApiError
from server.spec.models import SiteData
from server.spec.sample import render_sample

ACTOR, ORIGIN = "assistant:test", "https://site.example"
SAMPLE = json.loads((Path(__file__).parents[3] / "themes/listing-page/sample.json").read_text())


@pytest.fixture(autouse=True)
async def clear(db):
    await db.execute(
        "TRUNCATE site_fields,site_embed_sources,items,revisions,live,approvals,publishes,idempotency"
    )


async def publish(db, item):
    a = await approvals.request(db, ACTOR, [item["id"]], "")
    await approvals.decide(db, a["id"], {item["id"]: {"decision": "approve"}}, "", ORIGIN)


async def test_approval_removal_rollback_revert_and_legacy_payloads(db):
    one = await content.create_item(db, ACTOR, "site", {"broker": "Example Brokerage"}, None)
    assert (await content.site_data(db, True))["broker"] == ""
    await publish(db, one)
    two = await content.update_item(
        db, ACTOR, "site", one["version"], {"broker": "Another Brokerage"}
    )
    assert (await content.get_item(db, "site"))["data"]["broker"] == "Another Brokerage"
    assert (await content.site_data(db, True))["broker"] == "Example Brokerage"
    await publish(db, two)
    second = (await history.publishes(db))[0]["id"]
    removed = await content.update_item(db, ACTOR, "site", two["version"], {"broker": ""})
    await publish(db, removed)
    assert (await content.site_data(db, True))["broker"] == ""
    restored = await content.rollback(db, ACTOR, "site", one["version"], removed["version"])
    assert restored["data"]["broker"] == "Example Brokerage"
    await publish(db, restored)
    await history.revert(db, second, "", ORIGIN)
    assert (await content.site_data(db, True))["broker"] == "Another Brokerage"
    rows = await db.fetch(
        "SELECT data FROM items WHERE id='site' UNION ALL SELECT data FROM revisions WHERE item_id='site' UNION ALL SELECT data FROM live WHERE item_id='site'"
    )
    for row in rows:
        data = json.loads(row["data"])
        assert "broker" not in data
        SiteData.model_validate(data)


async def test_old_runtime_copy_stale_write_and_input_bounds(db):
    one = await content.create_item(db, ACTOR, "site", {"broker": "Approved Brokerage"}, None)
    await publish(db, one)
    await content.update_item(db, ACTOR, "site", 1, {"broker": "Unseen Brokerage"})
    await db.execute(
        "UPDATE live SET data=(SELECT data FROM items WHERE id='site'),version=2 WHERE item_id='site'"
    )
    assert (await content.site_data(db, True))["broker"] == ""
    with pytest.raises(ApiError) as error:
        await content.update_item(db, ACTOR, "site", 1, {"broker": "Wrong"})
    assert error.value.code == "version_conflict"
    assert await db.fetchval("SELECT count(*) FROM site_fields") == 2
    with pytest.raises(ApiError):
        content.validate("site", {"broker": "x" * 161})
    with pytest.raises(ApiError):
        content.validate("site", {"unknown_extension": "x"})
    assert len(content.validate("site", {"broker": "x" * 160})["broker"]) == 160


def test_listing_visible_cards_and_escaped_brokerage():
    sample = deepcopy(SAMPLE)
    sample["site"]["broker"] = "<Broker & Co>"
    sample["items"] += [
        {
            "kind": "card",
            "data": {
                "name": "A public highlight",
                "description": "Visible",
                "link": "https://example.com/visit",
            },
        },
        {
            "kind": "card",
            "data": {
                "name": "Mention highlight",
                "description": "Name only",
                "visibility": "mention",
                "link": "https://private.example/secret",
                "image": "https://private.example/secret.jpg",
            },
        },
        {
            "kind": "card",
            "data": {"name": "Private highlight", "description": "Hidden", "visibility": "private"},
        },
    ]
    pages = render_sample("listing-page", sample)
    for key in ["index.html", "listing/home/index.html"]:
        html = pages[key]
        assert "&lt;Broker &amp; Co&gt;" in html
        assert html.index('class="broker"') > html.index("owner@example.com")
        assert html.index('class="highlights"') > html.index('class="stats"')
        assert "A public highlight" in html and "Mention highlight" in html
        assert "Private highlight" not in html and "private.example" not in html
        assert 'id="cards"' in html
    sample["items"] = [item for item in sample["items"] if item["kind"] == "card"]
    assert "A public highlight" in render_sample("listing-page", sample)["index.html"]


async def test_real_site_state_contains_broker_and_guide(db, http):
    from .web import Mcp
    await content.create_item(db, ACTOR, "site", {"broker": "Example Brokerage"}, None)
    assistant = Mcp(http, await oauth.mint(db, "Test", ORIGIN))
    error, state, _ = await assistant.call("site_state", ids=["site"])
    assert not error
    assert state["items"][0]["data"]["broker"] == "Example Brokerage"
    assert "broker" in json.dumps(state["fields"])


def test_listing_highlights_only_on_home_and_feature_stream_entries():
    sample = deepcopy(SAMPLE)
    sample["site"]["streams"][0]["path"] = "property"
    sample["site"]["streams"].append({"id": "more", "title": "More", "layout": "list"})
    sample["site"]["sections"].append("more")
    for slug in ["visit", "photos"]:
        sample["items"].append({
            "kind": "entry", "slug": slug,
            "data": {"stream": "more", "title": slug, "date": "2026-10-16",
                     "tags": ["details"], "body": "Supporting page"},
        })
    pages = render_sample("listing-page", sample)
    for key in ["index.html", "property/home/index.html"]:
        assert 'class="highlights"' in pages[key], key
    for key in ["more/visit/index.html", "more/photos/index.html", "more/index.html",
                "more/tags/details/index.html", "property/index.html",
                "property/tags/property/index.html", "404.html"]:
        assert 'class="highlights"' not in pages[key], key
        assert "Room to gather" not in pages[key], key
