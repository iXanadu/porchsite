"""Paired metadata regression fixtures encoded from a synthetic canvas image."""

import base64
import hashlib
import json
import struct
import zlib
from pathlib import Path

import pytest

from server.app import media
from server.app.image_add import image_add
from server.app.image_privacy import strip_location

CASES = json.loads((Path(__file__).parents[3] / "spec/image-privacy-cases.json").read_text())
MINIMAL = bytes.fromhex("49492a0008000000010012010300010000000600000000000000")


def get(name):
    return base64.b64decode(CASES[name])


def parts(b, type_):
    out = []
    if type_ == "jpeg":
        p = 2
        while p + 4 <= len(b):
            marker, n = struct.unpack_from(">HH", b, p)
            if marker == 0xFFDA:
                out.append(("pixels", b[p:]))
                break
            out.append(("EXIF" if marker == 0xFFE1 else str(marker), b[p + 4 : p + 2 + n]))
            p += 2 + n
    elif type_ == "png":
        p = 8
        while p + 12 <= len(b):
            n = struct.unpack_from(">I", b, p)[0]
            out.append((b[p + 4 : p + 8].decode(), b[p + 8 : p + 8 + n]))
            p += n + 12
    else:
        p = 12
        while p + 8 <= len(b):
            n = struct.unpack_from("<I", b, p + 4)[0]
            out.append((b[p : p + 4].decode(), b[p + 8 : p + 8 + n]))
            p += 8 + n + n % 2
    return out


def exif(b, type_):
    value = next((d for n, d in parts(b, type_) if n in ("EXIF", "eXIf")), None)
    return value[6:] if value is not None and type_ == "jpeg" else value


def encoded(b, type_):
    return [
        d
        for n, d in parts(b, type_)
        if n
        in ({"pixels"} if type_ == "jpeg" else {"IDAT"} if type_ == "png" else {"VP8 ", "VP8L"})
    ]


@pytest.mark.parametrize("type_", ["jpeg", "png", "webp"])
def test_removes_separate_gps_ifd_preserves_orientation_pixels_and_plain_bytes(type_):
    original = get("gps." + type_)
    result = strip_location(original, "image/" + type_)
    assert exif(result, type_) == MINIMAL
    assert encoded(result, type_) == encoded(original, type_)
    assert media.sniff(result) == "image/" + type_
    assert media.size(result) == media.size(original)
    assert strip_location(result, "image/" + type_) is result
    plain = get("plain." + type_)
    assert strip_location(plain, "image/" + type_) is plain


@pytest.mark.parametrize("type_", ["jpeg", "png", "webp"])
@pytest.mark.parametrize("mutation", ["cycle", "offset", "count", "truncated"])
def test_bounds_hostile_tiff_reads_without_copying_old_pointers(type_, mutation):
    b = bytearray(get("gps." + type_))
    data = next(d for n, d in parts(b, type_) if n in ("EXIF", "eXIf"))
    index = b.find(data) + (6 if type_ == "jpeg" else 0)
    if mutation == "cycle":
        struct.pack_into("<I", b, index + 34, 8)
    if mutation == "offset":
        struct.pack_into("<I", b, index + 4, 0xFFFFFFF0)
    if mutation == "count":
        struct.pack_into("<H", b, index + 8, 65535)
    if mutation == "truncated":
        struct.pack_into("<I", b, index + 4, len(data) - 1)
    result = strip_location(bytes(b), "image/" + type_)
    assert encoded(result, type_) == encoded(b, type_)
    assert exif(result, type_) == (MINIMAL if mutation == "cycle" else None)


@pytest.mark.parametrize("type_", ["jpeg", "png", "webp"])
async def test_sanitized_hash_is_shared_by_single_batch_and_central_store(db, type_):
    b = get("gps." + type_)
    clean = strip_location(b, "image/" + type_)
    a = await image_add(db, "assistant:test", base64.b64encode(b).decode())
    batch = await image_add(
        db, "assistant:test", images=[base64.b64encode(x).decode() for x in (b, clean)]
    )
    shared = await media.store(db, b, "image/" + type_, "upload")
    assert [x["image"] for x in batch["images"]] == [a["image"], a["image"]]
    assert shared == a["image"]
    assert hashlib.sha256(clean).hexdigest()[:32] in shared
    assert (await media.serve(db, shared.split("/")[-1], False))["body"] == clean


def test_discards_text_and_xmp_without_xml_or_decompression():
    marker = b'GPSLatitude="12.34" <!DOCTYPE x SYSTEM "https://example.com/">'
    b = get("gps.jpeg")
    chunk = b"\xff\xe1" + struct.pack(">H", len(marker) + 2) + marker
    assert strip_location(b[:2] + chunk + b[2:], "image/jpeg") == strip_location(b, "image/jpeg")
    for kind in (b"tEXt", b"iTXt", b"zTXt"):
        b = get("gps.png")
        chunk = struct.pack(">I", len(marker)) + kind + marker + bytes(4)
        assert strip_location(b[:33] + chunk + b[33:], "image/png") == strip_location(
            b, "image/png"
        )
    b = get("gps.webp")
    chunk = b"XMP " + struct.pack("<I", len(marker)) + marker + bytes(len(marker) % 2)
    data = b + chunk
    data = data[:4] + struct.pack("<I", len(data) - 8) + data[8:]
    assert strip_location(data, "image/webp") == strip_location(b, "image/webp")


def test_preserves_metadata_free_png_with_many_empty_pixel_chunks():
    plain = get("plain.png")
    empty = bytes([0, 0, 0, 0, 73, 68, 65, 84, 53, 175, 6, 30])
    picture = plain[:-12] + empty * 5000 + plain[-12:]
    assert strip_location(picture, "image/png") is picture


async def test_stores_original_4121_idat_png_bytes_and_dimensions(db):
    b = get("many-idat.png")
    assert len(b) == 61860
    assert strip_location(b, "image/png") is b
    result = await image_add(db, "assistant:test", base64.b64encode(b).decode())
    assert (result["width"], result["height"]) == (64, 64)
    assert (await media.serve(db, result["image"].split("/")[-1], False))["body"] == b


def png_chunk(kind, payload):
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload))
    )


def web_chunk(kind, payload):
    return kind + struct.pack("<I", len(payload)) + payload + bytes(len(payload) % 2)


def test_keeps_jpeg_app2_png_iccp_and_webp_iccp_colour_profiles():
    profile = b"opaque colour profile"
    j = get("gps.jpeg")
    payload = b"ICC_PROFILE\0\x01\x01" + profile
    app = b"\xff\xe2" + struct.pack(">H", len(payload) + 2) + payload
    assert app in strip_location(j[:2] + app + j[2:], "image/jpeg")
    p = get("gps.png")
    icc = png_chunk(b"iCCP", b"profile\0\0" + profile)
    assert icc in strip_location(p[:33] + icc + p[33:], "image/png")
    w = get("gps.webp")
    chunk = web_chunk(b"ICCP", profile)
    data = w + chunk
    data = data[:4] + struct.pack("<I", len(data) - 8) + data[8:]
    assert chunk in strip_location(data, "image/webp")


def test_keeps_many_non_metadata_jpeg_webp_segments_with_packet_like_bytes():
    j = get("plain.jpeg")
    jpeg = j[:2] + b"\xff\xe2\0\x04\xff\xe1" * 5000 + j[2:]
    assert strip_location(jpeg, "image/jpeg") is jpeg
    w = get("plain.webp")
    webp = w + web_chunk(b"JUNK", b"EXIF") * 5000 + web_chunk(b"fAk!", b"EXIF")
    webp = webp[:4] + struct.pack("<I", len(webp) - 8) + webp[8:]
    assert strip_location(webp, "image/webp") is webp


def test_walks_many_idat_with_gps_and_preserves_all_pixel_chunks():
    b = get("many-idat.png")
    gps = next(d for n, d in parts(get("gps.png"), "png") if n == "eXIf")
    result = strip_location(b[:33] + png_chunk(b"eXIf", gps) + b[33:], "image/png")
    assert exif(result, "png") == MINIMAL
    assert encoded(result, "png") == encoded(b, "png")
