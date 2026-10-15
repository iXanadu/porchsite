"""Batch image_add acceptance: port of stage-two-images.test.ts."""
import base64
import json
import asyncio
import pytest

from server.app import mcp, oauth, uploads

from .web import Mcp


def png(n, size=24):
    header = bytes([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,n,0,0,0,1])
    return base64.b64encode(header + bytes(size - 24)).decode()


async def stored(db):
    return [dict(r) for r in await db.fetch("SELECT name, size FROM media ORDER BY name")]


async def test_accepts_eight_pictures_in_input_order(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, result, _ = await a.call("image_add", images=[png(n + 1) for n in range(8)])
    assert not err
    assert len(result["images"]) == 8
    assert [(x["width"], x["height"]) for x in result["images"]] == [(n + 1, 1) for n in range(8)]
    assert len({x["image"] for x in result["images"]}) == 8


async def test_refuses_nine_pictures_without_storing_anything(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    before = await stored(db)
    err, result, _ = await a.call("image_add", images=[png(n + 20) for n in range(9)])
    assert err
    assert "8" in str(result) or "eight" in str(result).lower()
    assert await stored(db) == before


async def test_legacy_data_and_single_batch_keep_distinct_response_shapes(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, legacy, _ = await a.call("image_add", data=png(90))
    assert not err and "images" not in legacy
    err, batch, _ = await a.call("image_add", images=[png(90)])
    assert not err and "image" not in batch
    assert batch["images"] == [{"image": legacy["image"], "width": 90, "height": 1}]


@pytest.mark.parametrize("args", [{}, {"data": png(91), "images": [png(92)]}, {"images": []}, {"images": None}, {"images": [None]}, {"images": [[png(93)]]}, {"images": {}}, {"data": png(94), "images": None}, {"data": None, "images": [png(95)]}])
async def test_refuses_invalid_shapes_without_writes(db, http, args):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    before = await stored(db)
    err, _, _ = await a.call("image_add", **args)
    assert err
    assert await stored(db) == before


async def test_bad_base64_and_oversized_file_store_nothing(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    before = await stored(db)
    err, result, _ = await a.call("image_add", images=[png(94), "not base64!!"])
    assert err and result["error"] == "invalid"
    response = await mcp._call(db, "image_add", {"images": [png(95), png(96, 8 * 1024 * 1024 + 1)]}, {"client": "Test", "origin": "https://site.example"}, "test")
    assert response.is_error and "8" in response.content[0].text
    assert await stored(db) == before


async def test_duplicate_positions_store_the_hash_once(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    before = await stored(db)
    err, result, _ = await a.call("image_add", images=[png(97), png(97)])
    assert not err
    assert len(result["images"]) == 2 and result["images"][0] == result["images"][1]
    assert len(await stored(db)) == len(before) + 1


async def test_existing_hash_survives_and_transaction_rolls_back_storage_failure(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, _, _ = await a.call("image_add", data=png(98))
    assert not err
    before = await stored(db)
    await db.execute("CREATE FUNCTION s2_refuse_media() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.width = 100 THEN RAISE EXCEPTION 'injected media write failure'; END IF; RETURN NEW; END $$")
    await db.execute("CREATE TRIGGER s2_refuse_media BEFORE INSERT ON media FOR EACH ROW EXECUTE FUNCTION s2_refuse_media()")
    try:
        try:
            err, _, _ = await a.call("image_add", images=[png(98), png(99), png(100)])
        except Exception:
            err = True
        assert err
        assert await stored(db) == before
    finally:
        await db.execute("DROP TRIGGER s2_refuse_media ON media")
        await db.execute("DROP FUNCTION s2_refuse_media()")


async def test_accepts_exactly_8_mib_decoded_spread_over_eight_files(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, result, _ = await a.call("image_add", images=[png(150 + n, 1024 * 1024) for n in range(8)])
    assert not err
    assert len(result["images"]) == 8
    assert [(x["width"], x["height"]) for x in result["images"]] == [(150 + n, 1) for n in range(8)]


async def test_refuses_8_mib_plus_one_byte_before_decoding_any_file(db, http, monkeypatch):
    before = await stored(db)
    first = png(60, 4 * 1024 * 1024)
    # Isolate the decoded-size rule from the separate HTTP body-size cap.
    second = png(61, 4 * 1024 * 1024 + 1)
    calls = []
    original = base64.b64decode
    def decode(*args, **kwargs):
        calls.append(True)
        return original(*args, **kwargs)
    monkeypatch.setattr(base64, "b64decode", decode)
    response = await mcp._call(db, "image_add", {"images": [first, second]}, {"client": "Test", "origin": "https://site.example"}, "test")
    assert not calls
    assert response.is_error
    result = json.loads(response.content[0].text)
    assert "8" in str(result)
    assert await stored(db) == before


async def test_stores_none_when_one_bad_picture_follows_valid_pictures(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    before = await stored(db)
    err, result, _ = await a.call("image_add", images=[*[png(80 + n) for n in range(7)], base64.b64encode(b"this is not an image").decode()])
    assert err
    assert result["error"] == "not_an_image"
    assert await stored(db) == before


@pytest.mark.parametrize("raw", [b"<svg></svg>", b"<html>not a picture</html>", b"GIF89a", b"%PDF-1.7", b"\xff\xd8"])
async def test_sniffs_every_file_instead_of_trusting_declared_type(db, http, raw):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    before = await stored(db)
    err, result, _ = await a.call("image_add", images=[png(120), "data:image/png;base64," + base64.b64encode(raw).decode()])
    assert err and result["error"] == "not_an_image"
    assert await stored(db) == before


async def test_uses_sniffed_type_and_byte_hash_ignoring_filename(db, http):
    import hashlib
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    encoded = png(121)
    err, result, _ = await a.call("image_add", images=["data:image/gif;base64," + encoded], name="../../etc/passwd", filename="wrong.jpg")
    assert not err
    name = hashlib.sha256(base64.b64decode(encoded)).hexdigest()[:32]
    assert result["images"][0] == {"image": f"/media/{name}.png", "width": 121, "height": 1}


async def test_auth_for_both_inputs_and_no_public_batch_endpoint(db, http):
    before = await stored(db)
    for args in [{"data": png(122)}, {"images": [png(123)]}]:
        response = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "image_add", "arguments": args}}, headers={"accept": "application/json, text/event-stream"})
        assert response.status_code == 401
    for path in ["/image_add", "/images", "/api/images"]:
        assert (await http.post(path, json={"images": [png(124)]})).status_code >= 300
    assert await stored(db) == before


async def test_batch_output_private_and_one_shot_link_single_file(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, result, _ = await a.call("image_add", images=[png(125)])
    assert not err
    assert (await http.get(result["images"][0]["image"])).status_code == 404
    before = await stored(db)
    link = await uploads.create(db, "assistant:test", "")
    response = await http.post(link["path"], files=[("photo", (f"{n}.png", base64.b64decode(png(n)), "image/png")) for n in [126, 127]], data={"alt": "Test pictures"}, headers={"accept": "application/json"})
    assert response.status_code >= 400
    assert await stored(db) == before
    assert (await uploads.get(db, link["id"]))["status"] == "waiting"


async def test_overlapping_failed_call_leaves_only_successful_batch_images(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    b = Mcp(http, await oauth.mint(db, "Other test", "https://site.example"))
    before = await stored(db)
    success, failure = await asyncio.gather(a.call("image_add", images=[png(130), png(131)]), b.call("image_add", images=[png(130), png(132), base64.b64encode(b"not an image").decode()]))
    assert not success[0] and failure[0]
    known = {row["name"] for row in before}
    assert sorted(f'/media/{row["name"]}' for row in await stored(db) if row["name"] not in known) == sorted(x["image"] for x in success[1]["images"])


async def test_full_cap_reaches_the_authenticated_http_transport(db, http):
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, result, _ = await a.call("image_add", images=[png(n, 1024 * 1024) for n in range(160, 168)])
    assert not err
    assert len(result["images"]) == 8
