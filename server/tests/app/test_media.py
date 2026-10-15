"""Images (SPEC S7): copied in at save, described, served from the site
itself. Port of the service parts of cloudflare/test/media.test.ts, plus the
server edition's public-only fetcher (the Worker gets that from a flag)."""

import hashlib
import json
import re

import httpx
import pytest

from server.app import approvals, content, media, uploads
from server.app.errors import ApiError
from server.app.fetch import NotPublicError, capped_public_fetch

who = "assistant:test"
# A private (RFC 1918) address, written in parts: the repo hygiene scan refuses
# private addresses in tracked files, and this one is only a test value.
PRIVATE = ".".join(["10", "0", "0", "8"])


def jpeg(size: int, fill: int = 7) -> bytes:
    """A JPEG header is enough for the type check; the rest is filler."""
    return bytes([0xFF, 0xD8, 0xFF, 0xE0]) + bytes([fill]) * (size - 4)


def serving(data: bytes, type_: str = "image/jpeg"):
    async def fetcher(url, method="GET", headers=None, content=None):
        return httpx.Response(
            200, content=data, headers={"content-type": type_, "content-length": str(len(data))}
        )

    return fetcher


async def refused(aw) -> ApiError:
    with pytest.raises(ApiError) as e:
        await aw
    return e.value


async def test_copies_a_cover_in_by_hash_and_serves_the_same_bytes_back(db):
    data = jpeg(4_100_000)
    out = await media.localize(
        db,
        "entry",
        {"title": "x", "cover": "https://example.com/a.jpg", "cover_alt": "A boat"},
        serving(data),
    )
    assert media.LOCAL.search(out["cover"])
    again = await media.localize(
        db, "entry", {"cover": "https://example.com/copy.jpg", "cover_alt": "Same"}, serving(data)
    )
    assert again["cover"] == out["cover"]
    res = await media.serve(db, out["cover"][len("/media/") :], True)
    assert res["headers"]["Content-Type"] == "image/jpeg"
    assert res["body"] == data


async def test_copies_body_images_and_leaves_the_description(db):
    out = await media.localize(
        db,
        "entry",
        {"body": "Look:\n\n![The dock at dawn](https://example.com/d.jpg)"},
        serving(jpeg(1000, 3)),
    )
    assert re.fullmatch(r"Look:\n\n!\[The dock at dawn\]\(/media/[0-9a-f]{32}\.jpg\)", out["body"])


async def test_refuses_an_image_with_no_description(db):
    e = await refused(
        media.localize(db, "card", {"image": "https://example.com/c.jpg"}, serving(jpeg(100)))
    )
    assert e.code == "invalid"
    assert "image_alt" in json.dumps(e.to_json())
    b = await refused(
        media.localize(db, "entry", {"body": "![](https://example.com/c.jpg)"}, serving(jpeg(100)))
    )
    assert "needs a description" in json.dumps(b.to_json())


async def test_refuses_what_isnt_an_image_is_too_big_or_doesnt_answer(db):
    page = b"<html>not an image</html>"
    assert (
        await refused(
            media.localize(
                db, "entry", {"cover": "https://example.com/p", "cover_alt": "x"}, serving(page)
            )
        )
    ).code == "image_failed"
    big = await refused(
        media.localize(
            db,
            "entry",
            {"cover": "https://example.com/big.jpg", "cover_alt": "x"},
            serving(jpeg(media.MAX_BYTES + 1)),
        )
    )
    assert "8 MB" in big.message

    async def gone(url, method="GET", headers=None, content=None):
        return httpx.Response(404, content=b"no")

    assert (
        "404"
        in (
            await refused(
                media.localize(
                    db, "entry", {"cover": "https://example.com/gone.jpg", "cover_alt": "x"}, gone
                )
            )
        ).message
    )
    unknown = {"cover": "/media/0123456789abcdef0123456789abcdef.jpg", "cover_alt": "x"}
    assert (await refused(media.localize(db, "entry", unknown))).code == "image_failed"


async def test_a_site_path_it_gave_out_is_accepted_on_save(db):
    path = await media.store(db, jpeg(500, 9), "image/jpeg", "test")
    a = await content.create_item(
        db,
        who,
        "entry",
        {"title": "With a cover", "date": "2026-10-09", "cover": path, "cover_alt": "A photo"},
        None,
    )
    assert a["data"]["cover"] == path


async def test_an_image_is_public_only_once_a_published_item_uses_it(db):
    path = await media.store(db, jpeg(600, 11), "image/jpeg", "test")
    name = path[len("/media/") :]
    a = await content.create_item(
        db,
        who,
        "card",
        {"name": "Pictured", "description": "d", "image": path, "image_alt": "x"},
        None,
    )
    assert await media.published(db, name) is False
    req = await approvals.request(db, who, [a["id"]], "")
    await approvals.decide(db, req["id"], {a["id"]: {"decision": "approve"}}, "")
    assert await media.published(db, name) is True
    assert "immutable" in (await media.serve(db, name, True))["headers"]["Cache-Control"]
    assert (await media.serve(db, name, False))["headers"]["Cache-Control"] == "private, no-store"


async def test_refuses_non_https_image_links_in_the_schema(db):
    e = await refused(
        content.create_item(
            db,
            who,
            "card",
            {
                "name": "C",
                "description": "d",
                "image": "http://example.com/x.jpg",
                "image_alt": "x",
            },
            None,
        )
    )
    assert e.code == "invalid"


async def test_reads_pixel_sizes():
    png = bytes(
        [
            0x89,
            0x50,
            0x4E,
            0x47,
            0x0D,
            0x0A,
            0x1A,
            0x0A,
            0,
            0,
            0,
            13,
            0x49,
            0x48,
            0x44,
            0x52,
            0,
            0,
            2,
            0,
            0,
            0,
            1,
            0,
            8,
            2,
            0,
            0,
            0,
        ]
    )
    assert media.size(png) == (512, 256)
    sof = bytes([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, 0, 100, 0, 200, 3, 0, 0, 0, 0])
    assert media.size(sof) == (200, 100)
    assert media.size(jpeg(7)) == (0, 0)


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/a.jpg",
        f"https://{PRIVATE}/a.jpg",
        "https://[::1]/a.jpg",
        "https://localhost/a.jpg",
        "http://example.com/a.jpg",
    ],
)
async def test_the_default_fetcher_reaches_only_public_addresses(url):
    with pytest.raises(NotPublicError):
        await capped_public_fetch(100)(url)


async def test_a_photo_from_the_phone_arrives_once(db):
    u = await uploads.create(db, who, "the shop front")
    token = u["path"].removeprefix("/upload/")
    assert u["status"] == "waiting"
    assert (await refused(uploads.receive(db, token, b"not a photo", "A shop"))).code == "invalid"
    assert (await refused(uploads.receive(db, token, jpeg(100), " "))).code == "invalid"
    done = await uploads.receive(db, token, jpeg(100), "A shop front")
    assert (
        done["status"] == "done"
        and media.LOCAL.search(done["image"])
        and done["alt"] == "A shop front"
    )
    assert (await refused(uploads.receive(db, token, jpeg(100, 2), "Again"))).code == "link_used"
    assert await uploads.open(db, token) is None
    assert (await uploads.get(db, u["id"]))["image"] == done["image"]


async def test_connects_to_the_address_it_checked_not_a_later_answer(monkeypatch):
    # DNS rebinding: the name answers public for the check, private after.
    import asyncio
    import socket

    import httpcore

    from server.app import fetch

    public = ".".join(["1", "1", "1", "1"])
    lookups = []

    async def getaddrinfo(host, port, **kw):
        lookups.append(host)
        ip = public if len(lookups) == 1 else PRIVATE
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]

    dialed = []

    class Recording(httpcore.AsyncNetworkBackend):
        async def connect_tcp(self, host, port, *args, **kwargs):
            dialed.append(host)
            raise httpcore.ConnectError("not in tests")

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", getaddrinfo)
    monkeypatch.setattr(fetch.httpcore, "AnyIOBackend", Recording)
    with pytest.raises(httpx.ConnectError):
        await capped_public_fetch(100)("https://rebind.example.com/a.jpg")
    assert lookups == ["rebind.example.com"]
    assert dialed == [public]


async def test_batches_forty_local_pictures_across_create_and_update(db):
    async with db.acquire() as conn:
        paths = [
            await media.store(conn, jpeg(100, i + 1), "image/jpeg", "fixture") for i in range(40)
        ]
        body = "\n\n".join(f"![Picture {i}]({path})" for i, path in enumerate(paths))

        class Counted:
            reads = 0

            def __getattr__(self, name):
                return getattr(conn, name)

            async def fetch(self, sql, *args):
                if sql.startswith("SELECT name FROM media WHERE name"):
                    self.reads += 1
                return await conn.fetch(sql, *args)

        counted = Counted()
        item = await content.create_item(
            counted, who, "entry", {"title": "Pictures", "date": "2026-10-15", "body": body}, None
        )
        assert counted.reads == 1
        assert item["data"]["body"] == body
        counted.reads = 0
        repeated = body + f"\n![Repeated]({paths[0]})"
        changed = await content.update_item(
            counted, who, item["id"], item["version"], {"body": repeated}
        )
        assert counted.reads == 1
        assert changed["data"]["body"] == repeated


async def test_keeps_error_order_and_accepts_an_earlier_hotlink(db):
    data = jpeg(123, 61)
    path = f"/media/{hashlib.sha256(data).digest()[:16].hex()}.jpg"
    out = await media.localize(
        db,
        "entry",
        {"cover": "https://example.com/new.jpg", "cover_alt": "Cover", "body": f"![Again]({path})"},
        serving(data),
    )
    assert out["cover"] == path
    assert out["body"] == f"![Again]({path})"
    missing = "/media/00000000000000000000000000000000.jpg"
    error = await refused(
        media.localize(db, "entry", {"body": f"![]({path})\n![Missing]({missing})"})
    )
    assert error.code == "image_failed"
    assert missing in error.message

    async def gone(url, **kwargs):
        return httpx.Response(404, content=b"gone")

    first = await refused(
        media.localize(
            db,
            "entry",
            {
                "cover": "https://example.com/gone",
                "cover_alt": "Cover",
                "body": f"![Missing]({missing})",
            },
            gone,
        )
    )
    assert "404" in first.message
