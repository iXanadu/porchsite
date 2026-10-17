"""Content service details the Cloudflare tests reach through other files:
slugs, removal, the validation problem list, streams (cloudflare/test/media.test.ts
"streams") and the schema applied twice."""

import pytest

from server.app import content
from server.app.db import apply_schema
from server.app.errors import ApiError

who = "assistant:test"


async def refused(aw) -> ApiError:
    with pytest.raises(ApiError) as e:
        await aw
    return e.value


async def test_slugs_come_from_date_and_title_and_must_be_unique(db):
    a = await content.create_item(
        db, who, "entry", {"title": "Hello, World!", "date": "2026-10-09"}, None
    )
    assert a["slug"] == "2026-10-09-hello-world"
    assert (
        await refused(
            content.create_item(
                db, who, "entry", {"title": "hello world", "date": "2026-10-09"}, None
            )
        )
    ).code == "slug_taken"
    b = await content.update_item(db, who, a["id"], 1, {"title": "Renamed"})
    assert b["slug"] == a["slug"]


async def test_remove_then_roll_back(db):
    a = await content.create_item(
        db, who, "note", {"text": "Gone soon", "date": "2026-10-09"}, None
    )
    r = await content.remove_item(db, who, a["id"], 1)
    assert r["deleted"] is True and r["version"] == 2
    assert (
        await refused(content.update_item(db, who, a["id"], 2, {"text": "x"}))
    ).code == "deleted"
    back = await content.rollback(db, who, a["id"], 1, 2)
    assert back["deleted"] is False and back["version"] == 3
    assert (await content.history(db, a["id"]))[0]["reason"] == "back to version 1"


async def test_problems_name_the_fields(db):
    e = await refused(
        content.create_item(db, who, "entry", {"date": "2026-10-09", "typo": 1}, None)
    )
    assert e.code == "invalid"
    fields = {p["field"]: p["problem"] for p in e.extra["problems"]}
    assert "title" in fields
    assert fields[""] == 'Unrecognized key: "typo"'
    assert (await refused(content.create_item(db, who, "page", {}, None))).message.startswith(
        "kind must be one of"
    )


def test_an_old_site_items_entries_heading_becomes_its_first_stream():
    s = content.validate("site", {"entries_title": "The diary"})
    assert s["streams"] == [
        {
            "id": "journal",
            "title": "The diary",
            "byline": "",
            "layout": "list",
            "link_label": "",
            "intro": "",
            "author": "",
            "nav_label": "",
            "path": "",
            "anchor": "",
            "description": "",
            "feed_subtitle": "",
            "see_also_label": "",
            "all_label": "",
            "dated_addresses": True,
            "sort": "date",
        }
    ]


async def test_refuses_sections_and_entries_that_name_no_stream(db):
    with pytest.raises(ApiError, match="doesn't validate"):
        content.validate("site", {"sections": ["writing"]})
    e = await refused(
        content.create_item(
            db, who, "entry", {"title": "Lost", "date": "2026-10-09", "stream": "nowhere"}, None
        )
    )
    assert "no stream" in str(e.to_json())


async def test_the_site_item_is_made_once(db):
    await content.create_item(db, who, "site", {"title": "Mine"}, None)
    assert (
        await refused(content.create_item(db, who, "site", {"title": "Again"}, None))
    ).code == "exists"
    assert (await refused(content.remove_item(db, who, "site", 1))).code == "invalid"


async def test_the_schema_applies_twice(db):
    assert await apply_schema(db) == []
