"""SV-PV2 acceptance, paired with cloudflare/test/media-http.test.ts."""

import asyncio
import hashlib
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest_asyncio

from server.app import content, media, privacy

from .conftest import TABLES
from .web import publish, session_hash, who

ORIGIN = "https://site.example"
BODY = bytes([255, 216, 255, 224, 0, 128, 254, 7])
CASES = json.loads((Path(__file__).resolve().parents[3] / "spec/media-http-cases.json").read_text())


@pytest_asyncio.fixture(autouse=True)
async def clean(db):
    await db.execute(f"TRUNCATE {TABLES} RESTART IDENTITY")
    await db.execute("UPDATE auth_state SET owner_epoch=0,private_floor='' WHERE id=1")


async def fixture(db):
    path = await media.store(db, BODY, "image/jpeg", "fixture")
    item = await content.create_item(db, who, "site", {"title": "Media fixture"}, None)
    card = await content.create_item(
        db,
        who,
        "card",
        {"name": "Picture", "description": "Picture", "image": path, "image_alt": "Fixture"},
        None,
    )
    await publish(db, [item["id"], card["id"]])
    return path, item, card


async def sessions(db):
    await db.execute(
        "INSERT INTO sessions (token_hash,created_at,expires_at) VALUES ($1,'2026-10-10','2099-01-01')",
        session_hash("owner-token"),
    )
    await db.execute(
        "INSERT INTO readers (id,name,created_at) VALUES ('reader','Reader','2026-10-10')"
    )
    await db.execute(
        "INSERT INTO reader_passkeys (id,reader_id,public_key,created_at) VALUES ('credential','reader',$1,'2026-10-10')",
        bytes([1]),
    )
    await db.execute(
        "INSERT INTO reader_sessions (token_hash,reader_id,credential_id,epoch,created_at,expires_at) VALUES ($1,'reader','credential',0,'2026-10-10','2099-01-01')",
        session_hash("reader-token"),
    )
    return ["__Host-sk_owner=owner-token", "__Host-sk_reader=reader-token"]


async def test_hashes_canonical_url_type_empty_signal_binary_bytes_and_head_matches_get(db, http):
    path, _, _ = await fixture(db)
    tag = (
        'W/"sha256-'
        + hashlib.sha256((ORIGIN + path + "\0image/jpeg\0\0").encode() + BODY).hexdigest()
        + '"'
    )
    response = await http.get(path + "?ignored=1")
    assert response.status_code == 200
    assert response.headers["etag"] == tag
    assert response.headers["cache-control"] == "no-cache, no-transform"
    assert response.content == BODY
    head = await http.head(path)
    assert head.status_code == 200
    assert head.headers == response.headers
    assert head.content == b""


async def test_weak_strong_wildcard_list_and_malformed_conditions_for_get_and_head(db, http):
    path, _, _ = await fixture(db)
    tag = (await http.get(path)).headers["etag"]
    for case in CASES:
        for method in ["GET", "HEAD"]:
            headers = {"If-Modified-Since": "Wed, 01 Jan 2099 00:00:00 GMT"}
            if case["value"] is not None:
                headers["If-None-Match"] = (
                    case["value"].replace("$tag", tag).replace("$strong", tag[2:])
                )
            response = await http.request(method, path, headers=headers)
            assert response.status_code == case["status"], (case["name"], method)
            assert response.headers["etag"] == tag
            assert response.headers["cache-control"] == "no-cache, no-transform"
            if case["status"] == 304 or method == "HEAD":
                assert response.content == b""
                if case["status"] == 304:
                    assert int(response.headers.get("content-length", 0)) == 0
            else:
                assert response.content == BODY


async def test_owner_reader_invalid_cookies_and_authorization_do_not_reuse_anonymous_tag(db, http):
    path, _, _ = await fixture(db)
    cookies = await sessions(db)
    tag = (await http.get(path)).headers["etag"]
    for actor in cookies + ["__Host-sk_owner=expired", "__Host-sk_reader=expired", "authorization"]:
        for method in ["GET", "HEAD"]:
            headers = (
                {"Authorization": "Bearer unused"}
                if actor == "authorization"
                else {"Cookie": actor}
            )
            response = await http.request(method, path, headers={**headers, "If-None-Match": tag})
            assert response.status_code == 200
            assert response.headers["cache-control"] == "private, no-store, no-transform"
            assert "etag" not in response.headers
            assert "last-modified" not in response.headers
    assert (
        await http.get(
            path, headers={"Cookie": "other=__Host-sk_reader=not-a-cookie", "If-None-Match": tag}
        )
    ).status_code == 304


async def test_last_published_reference_before_warm_tags_wildcard_and_history(
    db, http, monkeypatch
):
    path, _, card = await fixture(db)
    tag = (await http.get(path)).headers["etag"]
    other = await content.create_item(
        db,
        who,
        "card",
        {"name": "Other", "description": "d", "image": path, "image_alt": "Fixture"},
        None,
    )
    await publish(db, [other["id"]])
    await content.remove_item(db, who, card["id"], card["version"])
    await publish(db, [card["id"]])
    assert (await http.get(path, headers={"If-None-Match": tag})).status_code == 304
    await content.create_item(
        db,
        who,
        "card",
        {"name": "Pending", "description": "d", "image": path, "image_alt": "Fixture"},
        None,
    )
    await content.create_item(
        db,
        who,
        "entry",
        {
            "title": "Draft",
            "date": "2026-10-17",
            "status": "draft",
            "cover": path,
            "cover_alt": "Fixture",
        },
        None,
    )
    await content.remove_item(db, who, other["id"], other["version"])
    await publish(db, [other["id"]])
    read = AsyncMock(side_effect=AssertionError("bytes read after publication removed"))
    monkeypatch.setattr(media, "serve", read)
    for method in ["GET", "HEAD"]:
        for condition in [tag, "*"]:
            response = await http.request(method, path, headers={"If-None-Match": condition})
            assert response.status_code == 404
            assert response.headers["cache-control"] == "no-store"
            assert "etag" not in response.headers
    read.assert_not_awaited()


async def test_private_on_gates_warm_tags_before_bytes_owner_reader_remain_no_store(
    db, http, monkeypatch
):
    path, item, _ = await fixture(db)
    cookies = await sessions(db)
    tag = (await http.get(path)).headers["etag"]
    await content.update_item(db, who, item["id"], item["version"], {"private": True})
    await publish(db, [item["id"]])
    original = media.serve
    read = AsyncMock(side_effect=AssertionError("bytes read before private gate"))
    monkeypatch.setattr(media, "serve", read)
    for method in ["GET", "HEAD"]:
        for condition in [tag, "*"]:
            response = await http.request(method, path, headers={"If-None-Match": condition})
            assert response.status_code == 404
            assert response.text == ("" if method == "HEAD" else privacy.SIGN_IN)
            assert response.headers["cache-control"] == "private, no-store, no-transform"
            assert "etag" not in response.headers
    read.assert_not_awaited()
    monkeypatch.setattr(media, "serve", original)
    for cookie in cookies:
        for method in ["GET", "HEAD"]:
            response = await http.request(
                method, path, headers={"Cookie": cookie, "If-None-Match": tag}
            )
            assert response.status_code == 200
            assert response.headers["cache-control"] == "private, no-store, no-transform"
            assert "etag" not in response.headers


async def test_unpublished_pictures_owner_only_and_media_misses_no_store(db, http):
    await fixture(db)
    cookies = await sessions(db)
    path = await media.store(db, bytes([255, 216, 255, 224, 9]), "image/jpeg", "fixture")
    for cookie in ["", cookies[1]]:
        response = await http.get(path, headers={"Cookie": cookie, "If-None-Match": "*"})
        assert response.status_code == 404
        assert "no-store" in response.headers["cache-control"]
        assert "etag" not in response.headers
    response = await http.get(path, headers={"Cookie": cookies[0], "If-None-Match": "*"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store, no-transform"
    assert "etag" not in response.headers
    response = await http.head(
        "/media/00000000000000000000000000000000.jpg", headers={"If-None-Match": "*"}
    )
    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"


async def test_generated_share_pictures_revalidate_against_current_live_entry(db, http):
    await fixture(db)
    path = await media.store(db, bytes([255, 216, 255, 224, 10]), "image/jpeg", "fixture")
    entry = await content.create_item(
        db, who, "entry", {"title": "Shared", "date": "2026-10-17"}, None
    )
    await publish(db, [entry["id"]])
    await db.execute(
        "INSERT INTO share_cards (item_id,version,name,created_at) VALUES ($1,$2,$3,'2026-10-17')",
        entry["id"],
        entry["version"],
        path[7:],
    )
    tag = (await http.get(path)).headers["etag"]
    assert tag.startswith('W/"sha256-')
    assert (await http.head(path, headers={"If-None-Match": tag})).status_code == 304
    await content.remove_item(db, who, entry["id"], entry["version"])
    await publish(db, [entry["id"]])
    assert (await http.get(path, headers={"If-None-Match": tag})).status_code == 404


async def test_stalled_authorized_byte_read_cannot_refill_response_cache_after_removal(
    db, http, monkeypatch
):
    path, _, card = await fixture(db)
    entered, resume = asyncio.Event(), asyncio.Event()
    original = media.serve
    first = True

    async def stalled(*args):
        nonlocal first
        response = await original(*args)
        if first:
            first = False
            entered.set()
            await resume.wait()
        return response

    monkeypatch.setattr(media, "serve", stalled)
    pending = asyncio.create_task(http.get(path))
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        await content.remove_item(db, who, card["id"], card["version"])
        await publish(db, [card["id"]])
        assert (await http.get(path, headers={"If-None-Match": "*"})).status_code == 404
        resume.set()
        earlier = await pending
        assert earlier.status_code == 200  # Existing authorized in-flight response limitation.
        assert (
            await http.get(path, headers={"If-None-Match": earlier.headers["etag"]})
        ).status_code == 404
    finally:
        resume.set()
        await pending
