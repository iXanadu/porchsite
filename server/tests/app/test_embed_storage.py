"""Port-matched: cloudflare/test/embed-storage.test.ts."""

import json

import pytest

from server.app import approvals, content, history
from server.app.db import dumps
from server.app.embed_storage import migrate_sources
from server.spec.models import SiteData

A, B, ORIGIN = "https://example.com", "https://video.example", "https://site.example"


@pytest.fixture(autouse=True)
async def clear(db):
    await db.execute(
        "TRUNCATE site_embed_sources,approvals,publishes,live,revisions,items,idempotency"
    )


async def publish(db, item):
    a = await approvals.request(db, "assistant:test", [item["id"]], "")
    await approvals.decide(db, a["id"], {item["id"]: dict(decision="approve")}, "", ORIGIN)


async def clean_payloads(db):
    rows = await db.fetch(
        "SELECT data FROM items WHERE id = 'site' UNION ALL SELECT data FROM revisions WHERE item_id = 'site'"
        " UNION ALL SELECT data FROM live WHERE item_id = 'site'"
    )
    for row in rows:
        data = json.loads(row["data"])
        assert "embed_sources" not in data
        SiteData.model_validate(data)


async def test_versions_approval_and_history_keep_sources_outside_legacy_json(db):
    one = await content.create_item(db, "assistant:test", "site", dict(embed_sources=[A]), None)
    await clean_payloads(db)
    assert (await content.site_data(db, True))["embed_sources"] == []
    await publish(db, one)
    first = (await history.publishes(db))[0]["id"]
    assert (await content.site_data(db, True))["embed_sources"] == [A]
    two = await content.update_item(db, "assistant:test", "site", 1, dict(embed_sources=[B]))
    assert (await content.get_item(db, "site"))["data"]["embed_sources"] == [B]
    assert (await content.site_data(db, True))["embed_sources"] == [A]
    await publish(db, two)
    assert (await content.site_data(db, True))["embed_sources"] == [B]
    assert (await history.plan(db, first))["changes"][0]["data"]["embed_sources"] == [A]
    await history.revert(db, first, "", ORIGIN)
    assert (await content.site_data(db, True))["embed_sources"] == [A]
    current = await content.get_item(db, "site")
    restored = await content.rollback(db, "assistant:test", "site", 2, current["version"])
    assert restored["data"]["embed_sources"] == [B]
    assert (await content.site_data(db, True))["embed_sources"] == [A]
    await publish(db, restored)
    assert (await content.site_data(db, True))["embed_sources"] == [B]
    await clean_payloads(db)


async def test_repairs_legacy_live_and_pending_snapshots_without_promoting_drafts(db):
    one = await content.create_item(db, "assistant:test", "site", dict(embed_sources=[A]), None)
    await publish(db, one)
    two = await content.update_item(db, "assistant:test", "site", 1, dict(embed_sources=[B]))
    a = await approvals.request(db, "assistant:test", ["site"], "")
    await db.execute("DELETE FROM site_embed_sources")
    await db.execute("UPDATE items SET data = $1 WHERE id = 'site'", dumps({k: v for k, v in two["data"].items() if k != "broker"}))
    await db.execute(
        "UPDATE revisions SET data = $1 WHERE item_id = 'site' AND version = 1", dumps({k: v for k, v in one["data"].items() if k != "broker"})
    )
    await db.execute(
        "UPDATE revisions SET data = $1 WHERE item_id = 'site' AND version = 2", dumps({k: v for k, v in two["data"].items() if k != "broker"})
    )
    await db.execute("UPDATE live SET data = $1 WHERE item_id = 'site'", dumps({k: v for k, v in one["data"].items() if k != "broker"}))
    await content.create_item(
        db, "assistant:test", "note", dict(text="A note", date="2026-10-15"), None
    )
    await clean_payloads(db)
    assert (await content.site_data(db, True))["embed_sources"] == [A]
    assert (await content.site_data(db, False))["embed_sources"] == [B]
    pending = (await approvals.get(db, a["id"]))["items"][0]
    assert (pending["version"], pending["status"]) == (2, "pending")
    assert [
        dict(r)
        for r in await db.fetch("SELECT version,approved FROM site_embed_sources ORDER BY version")
    ] == [dict(version=1, approved=1), dict(version=2, approved=0)]
    await migrate_sources(db)
    await approvals.decide(db, a["id"], dict(site=dict(decision="approve")), "", ORIGIN)
    assert (await content.site_data(db, True))["embed_sources"] == [B]
    await clean_payloads(db)


@pytest.mark.parametrize("action", ["request", "decide"])
async def test_approval_repairs_legacy_inline_sources_without_content_write(db, action):
    one = await content.create_item(db, "assistant:test", "site", dict(embed_sources=[A]), None)
    await publish(db, one)
    two = await content.update_item(db, "assistant:test", "site", 1, dict(embed_sources=[B]))
    pending = await approvals.request(db, "assistant:test", ["site"], "")
    # Reconstruct the previous inline-storage format, including live and pending versions.
    await db.execute("DELETE FROM site_embed_sources")
    await db.execute("UPDATE items SET data = $1 WHERE id = 'site'", dumps({k: v for k, v in two["data"].items() if k != "broker"}))
    await db.execute(
        "UPDATE revisions SET data = $1 WHERE item_id = 'site' AND version = 1", dumps({k: v for k, v in one["data"].items() if k != "broker"})
    )
    await db.execute(
        "UPDATE revisions SET data = $1 WHERE item_id = 'site' AND version = 2", dumps({k: v for k, v in two["data"].items() if k != "broker"})
    )
    await db.execute("UPDATE live SET data = $1 WHERE item_id = 'site'", dumps({k: v for k, v in one["data"].items() if k != "broker"}))
    # A read does not repair; no content write or direct migration follows this seed.
    await content.site_data(db, True)
    assert await db.fetchval("SELECT COUNT(*) FROM site_embed_sources") == 0
    if action == "request":
        pending = await approvals.request(db, "assistant:test", ["site"], "")
        await clean_payloads(db)
        rows = await db.fetch("SELECT version,sources,approved FROM site_embed_sources ORDER BY version")
        assert [{**dict(r), "sources": json.loads(r["sources"])} for r in rows] == [
            dict(version=1, sources=[A], approved=1), dict(version=2, sources=[B], approved=0)
        ]
        assert (await approvals.get(db, pending["id"]))["items"][0]["status"] == "pending"
    await approvals.decide(db, pending["id"], dict(site=dict(decision="approve")), "", ORIGIN)
    await clean_payloads(db)
    assert (await content.site_data(db, True))["embed_sources"] == [B]
    rows = await db.fetch("SELECT version,sources,approved FROM site_embed_sources ORDER BY version")
    assert [{**dict(r), "sources": json.loads(r["sources"])} for r in rows] == [
        dict(version=1, sources=[A], approved=1), dict(version=2, sources=[B], approved=1)
    ]


async def test_old_bundle_cannot_publish_an_unseen_source_sidecar(db):
    one = await content.create_item(db, "assistant:test", "site", dict(embed_sources=[A]), None)
    await publish(db, one)
    await content.update_item(db, "assistant:test", "site", 1, dict(embed_sources=[B]))
    await db.execute(
        "UPDATE live SET data = (SELECT data FROM items WHERE id = 'site'), version = 2 WHERE item_id = 'site'"
    )
    assert (await content.site_data(db, True))["embed_sources"] == []
    three = await content.update_item(db, "assistant:test", "site", 2, dict(title="Changed"))
    await publish(db, three)
    assert (await content.site_data(db, True))["embed_sources"] == [B]
    with pytest.raises(Exception, match="version 3"):
        await content.update_item(db, "assistant:test", "site", 2, dict(embed_sources=[A]))
    assert (await content.site_data(db, True))["embed_sources"] == [B]
    await clean_payloads(db)


async def test_conflicting_legacy_versions_refuse_without_stripping_or_widening(db):
    one = await content.create_item(db, "assistant:test", "site", dict(embed_sources=[A]), None)
    await publish(db, one)
    await db.execute("DELETE FROM site_embed_sources")
    await db.execute(
        "UPDATE items SET data = $1 WHERE id = 'site'", dumps({**one["data"], "embed_sources": [B]})
    )
    await db.execute("UPDATE live SET data = $1 WHERE item_id = 'site'", dumps({k: v for k, v in one["data"].items() if k != "broker"}))
    with pytest.raises(Exception, match="sources disagree"):
        await migrate_sources(db)
    assert (await content.site_data(db, True))["embed_sources"] == [A]
    assert await db.fetchval("SELECT COUNT(*) FROM site_embed_sources") == 0
