"""Read-only checker fixtures; all images and HTTP responses are local bytes."""

import json
import runpy
import struct
import subprocess
import sys
import threading
import time
import zlib
from collections import Counter
from contextlib import contextmanager
from http.client import HTTPException, IncompleteRead, InvalidURL, LineTooLong
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[3] / "scripts" / "photo-location-check"
CHECK = runpy.run_path(str(SCRIPT))
GPS_XMP = b'<rdf:Description exif:GPSLatitude="12,34N" exif:GPSLongitude="56,7E"/>'
PLAIN_XMP = b'<rdf:Description exif:Make="Example camera"/>'
NAMES = ["a" * 32 + ".jpg", "b" * 32 + ".png", "c" * 32 + ".webp"]


def tiff(gps, endian="<", empty=False):
    header = (b"II" if endian == "<" else b"MM") + struct.pack(endian + "HI", 42, 8)
    if gps:
        entry = struct.pack(endian + "HHII", 0x8825, 4, 1, 26)
        directory = struct.pack(endian + "H", 0 if empty else 1)
        if not empty:
            directory += struct.pack(endian + "HHI", 0, 1, 4) + b"\x02\x03\0\0"
        return header + struct.pack(endian + "H", 1) + entry + bytes(4) + directory + bytes(4)
    entry = struct.pack(endian + "HHI", 0x112, 3, 1) + struct.pack(endian + "H", 6) + bytes(2)
    return header + struct.pack(endian + "H", 1) + entry + bytes(4)


def jpeg(packet=None, app=0xE1):
    segment = (
        b"" if packet is None else bytes([255, app]) + struct.pack(">H", len(packet) + 2) + packet
    )
    return b"\xff\xd8" + segment + b"\xff\xd9"


def png_chunk(name, data):
    return (
        struct.pack(">I", len(data))
        + name
        + data
        + struct.pack(">I", zlib.crc32(name + data) & 0xFFFFFFFF)
    )


def png(packet=None, name=b"eXIf"):
    ihdr = png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    return (
        b"\x89PNG\r\n\x1a\n"
        + ihdr
        + (png_chunk(name, packet) if packet is not None else b"")
        + png_chunk(b"IEND", b"")
    )


def webp(packet=None, name=b"EXIF"):
    chunks = b"VP8L" + struct.pack("<I", 2) + b"\x2f\0"
    if packet is not None:
        chunks += name + struct.pack("<I", len(packet)) + packet + bytes(len(packet) % 2)
    return b"RIFF" + struct.pack("<I", len(chunks) + 4) + b"WEBP" + chunks


@pytest.mark.parametrize("format", ["jpeg", "png", "webp"])
@pytest.mark.parametrize("endian", ["<", ">"])
@pytest.mark.parametrize("gps", [False, True])
def test_exif_gps_ifd_and_orientation_only(format, endian, gps):
    packet = tiff(gps, endian)
    if format == "jpeg":
        packet = b"Exif\0\0" + packet
    assert CHECK["has_location"](globals()[format](packet)) is gps


@pytest.mark.parametrize("format", ["jpeg", "png", "webp"])
def test_empty_gps_directory_is_not_location(format):
    packet = tiff(True, empty=True)
    assert not CHECK["has_location"](
        globals()[format]((b"Exif\0\0" if format == "jpeg" else b"") + packet)
    )


@pytest.mark.parametrize("gps", [False, True])
@pytest.mark.parametrize(
    "packet", ["jpeg", "webp", "png-text", "png-ztxt", "png-itxt", "png-itxt-compressed"]
)
def test_xmp_gps_properties_in_all_text_packets(packet, gps):
    text = GPS_XMP if gps else PLAIN_XMP
    if packet == "jpeg":
        image = jpeg(b"http://ns.adobe.com/xap/1.0/\0" + text)
    elif packet == "webp":
        image = webp(text, b"XMP ")
    elif packet == "png-text":
        image = png(b"XML:com.adobe.xmp\0" + text, b"tEXt")
    elif packet == "png-ztxt":
        image = png(b"XML:com.adobe.xmp\0\0" + zlib.compress(text), b"zTXt")
    else:
        compressed = packet.endswith("compressed")
        image = png(
            b"XML:com.adobe.xmp\0"
            + bytes([compressed, 0])
            + b"\0\0"
            + (zlib.compress(text) if compressed else text),
            b"iTXt",
        )
    assert CHECK["has_location"](image) is gps


def test_xmp_elements_and_utf16_and_known_app2_limit():
    text = '<e:GPSLatitude rdf:datatype="text">12</e:GPSLatitude>'.encode("utf-16")
    assert CHECK["has_location"](webp(text, b"XMP "))
    assert not CHECK["has_location"](jpeg(GPS_XMP, app=0xE2))
    assert "APP2" in CHECK["LIMITATION"]


@pytest.mark.parametrize(
    "image",
    [
        jpeg(b"Exif\0\0bad"),
        png(b"bad"),
        webp(b"bad"),
        b"unknown",
        png()[:-1],
        jpeg()[:-2],
        webp()[:-1],
        png(b"x\0\0broken", b"zTXt"),
    ],
)
def test_damaged_metadata_is_an_error(image):
    with pytest.raises(CHECK["CheckError"]):
        CHECK["has_location"](image)


def test_bad_gps_pointer_and_bounded_text_inflation():
    broken = bytearray(tiff(True))
    broken[18:22] = struct.pack("<I", 99999)
    with pytest.raises(CHECK["CheckError"]):
        CHECK["has_location"](jpeg(b"Exif\0\0" + broken))
    bomb = zlib.compress(b"a" * (CHECK["MAX_METADATA"] + 1))
    with pytest.raises(CHECK["CheckError"]):
        CHECK["has_location"](png(b"x\0\0" + bomb, b"zTXt"))


@contextmanager
def site(
    gps=False,
    private=False,
    broken_media=False,
    missing_page=False,
    redirect=None,
    slow=False,
    forbidden_page=False,
    short_page=False,
    short_media=False,
    long_header=False,
    space_page=False,
):
    hits, agents, cookies = Counter(), [], []
    images = [jpeg(b"Exif\0\0" + tiff(gps)), png(tiff(False)), webp(PLAIN_XMP, b"XMP ")]

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            hits[self.path] += 1
            if slow:
                time.sleep(0.05)
            agents.append(self.headers.get("User-Agent"))
            cookies.append(self.headers.get("Cookie"))
            kind, status = "text/html", 200
            if self.path == "/" and redirect:
                self.send_response(302)
                self.send_header("Location", redirect)
                self.end_headers()
                return
            if self.path == "/" and private:
                body, status = CHECK["BLANK"], 404
            elif self.path == "/":
                body = f'<link rel="alternate" type="application/rss+xml" href="/feed.xml"><img src="/media/{NAMES[0]}"><source srcset="/media/{NAMES[0]} 1x, /media/{NAMES[1]} 2x"><meta property="og:image" content="{origin}/media/{NAMES[2]}"><a href="/media/{NAMES[0]}?download=1">Photo</a><img src="https://outside.example/media/{NAMES[0]}">'.encode()
            elif self.path == "/sitemap.xml":
                kind = "application/xml"
                body = (
                    f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>{origin}/page/</loc></url>'
                    + (f"<url><loc>{origin}/missing/</loc></url>" if missing_page else "")
                    + (f"<url><loc>{origin}/%6dcp</loc></url>" if forbidden_page else "")
                    + (f"<url><loc>{origin}/a b/</loc></url>" if space_page else "")
                    + "</urlset>"
                ).encode()
            elif self.path == "/feed.xml":
                kind = "application/rss+xml"
                body = f'<rss><channel><item><link>{origin}/entry/</link><description><![CDATA[<img src="/media/{NAMES[0]}">]]></description></item></channel></rss>'.encode()
            elif self.path in ("/page/", "/entry/"):
                body = f'<img src="/media/{NAMES[0]}">'.encode()
            elif self.path.startswith("/media/") and self.path[7:] in NAMES:
                index = NAMES.index(self.path[7:])
                kind = ["image/jpeg", "image/png", "image/webp"][index]
                body = b"damaged" if broken_media and index == 0 else images[index]
            else:
                body, status = b"not found", 404
            short = (short_page and self.path == "/") or (
                short_media and self.path == "/media/" + NAMES[0]
            )
            if short_page and self.path == "/":
                body = b"<p>short"
            self.send_response(status)
            self.send_header("Content-Type", kind)
            if short:
                self.send_header("Content-Length", str(len(body) + 1000))
                self.close_connection = True
            if long_header:
                self.send_header("X-Long", "a" * 70000)
            try:
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    origin = f"http://127.0.0.1:{server.server_port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield origin, hits, agents, cookies
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def run(origin, *args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--site", origin, "--delay", "0", *args],
        capture_output=True,
        text=True,
        timeout=15,
    )


@pytest.mark.parametrize("gps", [False, True])
def test_local_site_discovers_sitemap_feed_srcset_meta_links_and_deduplicates(gps):
    with site(gps=gps) as (origin, hits, agents, cookies):
        result = run(origin, "--json")
    assert result.returncode == (2 if gps else 0), result.stderr
    report = json.loads(result.stdout)
    assert report["totals"] == {"yes": int(gps), "no": 3 - int(gps), "error": 0}
    assert not report["errors"]
    first = next(p for p in report["photos"] if p["url"].endswith(".jpg"))
    assert set(first["pages"]) == {
        origin + "/",
        origin + "/page/",
        origin + "/entry/",
        origin + "/feed.xml",
    }
    assert all(hits["/media/" + name] == 1 for name in NAMES)
    assert set(agents) == {CHECK["USER_AGENT"]} and set(cookies) == {None}
    assert all(not p.startswith(("/mcp", "/login")) for p in hits)


def test_private_site_stops_without_fetching_sitemap_or_photos():
    with site(private=True) as (origin, hits, _, _):
        result = run(origin, "--max-pages", "1")
    assert result.returncode == 0
    assert "site is private: nothing public to check" in result.stdout
    assert hits == {"/": 1}


@pytest.mark.parametrize("options", [{"broken_media": True}, {"missing_page": True}])
def test_page_or_photo_errors_are_not_reported_as_clean(options):
    with site(gps=True, **options) as (origin, _, _, _):
        result = run(origin, "--json")
    assert result.returncode == 1
    report = json.loads(result.stdout)
    assert report["totals"]["error"] or report["errors"]
    if options.get("broken_media"):
        assert report["photos"][0]["location"] == "error"


@pytest.mark.parametrize("flag", ["--max-pages", "--max-files"])
def test_limit_reports_incomplete_scan_and_fails(flag):
    with site() as (origin, _, _, _):
        result = run(origin, flag, "1", "--json")
    assert result.returncode == 1
    report = json.loads(result.stdout)
    assert report["stopped_at_limit"]
    assert "stopped at limit" in report["errors"][-1]["error"]


def test_external_redirect_is_refused_and_response_size_is_bounded():
    with site() as (outside, outside_hits, _, _):
        with site(redirect=outside) as (origin, _, _, _):
            result = run(origin, "--json")
        assert result.returncode == 1 and "outside the site origin" in result.stdout
        assert not outside_hits
        with pytest.raises(CHECK["CheckError"], match="response exceeds"):
            CHECK["Checker"](outside, delay=0).fetch(outside, 4)


def test_detection_matches_the_existing_stripper_packet_families():
    from server.app.image_privacy import strip_location

    for kind, image in [
        ("jpeg", jpeg(b"Exif\0\0" + tiff(True))),
        ("png", png(tiff(True))),
        ("webp", webp(tiff(True))),
        ("jpeg", jpeg(GPS_XMP)),
        ("png", png(b"x\0\0" + zlib.compress(GPS_XMP), b"zTXt")),
        ("webp", webp(GPS_XMP, b"XMP ")),
    ]:
        assert CHECK["has_location"](image)
        assert not CHECK["has_location"](strip_location(image, "image/" + kind))
    app2 = jpeg(GPS_XMP, app=0xE2)
    assert strip_location(app2, "image/jpeg") == app2  # documented existing limit


def test_effective_origin_and_media_query_deduplication():
    checker = CHECK["Checker"]("https://example.com")
    assert (
        checker.url(
            checker.site, "https://EXAMPLE.COM:443/media/" + NAMES[0] + "?v=1#photo", media=True
        )
        == "https://example.com/media/" + NAMES[0]
    )
    assert checker.url(checker.site, "http://example.com/media/" + NAMES[0], media=True) is None
    assert (
        checker.url(checker.site, "https://user@example.com/media/" + NAMES[0], media=True) is None
    )


def test_private_json_is_explicit_and_still_successful():
    with site(private=True) as (origin, hits, _, _):
        result = run(origin, "--json")
    assert result.returncode == 0
    report = json.loads(result.stdout)
    assert report["message"] == "site is private: nothing public to check"
    assert report["private"] and not report["photos"] and not report["errors"]
    assert hits == {"/": 1}


def test_polite_delay_and_request_timeout():
    with site() as (origin, _, _, _):
        checker = CHECK["Checker"](origin, delay=0.05)
        checker.fetch(origin, 4096)
        started = time.monotonic()
        checker.fetch(origin, 4096)
        assert time.monotonic() - started >= 0.04
    with site(slow=True) as (origin, _, _, _):
        with pytest.raises(CHECK["CheckError"], match="timed out"):
            CHECK["Checker"](origin, timeout=0.005, delay=0).fetch(origin, 4096)


@pytest.mark.parametrize(
    "flag,value", [("--timeout", "nan"), ("--delay", "inf"), ("--max-pages", "0")]
)
def test_invalid_bounds_are_json_errors(flag, value):
    result = run("https://example.com", flag, value, "--json")
    assert result.returncode == 1
    assert json.loads(result.stdout)["errors"]


@pytest.mark.parametrize("options", [{"forbidden_page": True}, {"redirect": "/mcp"}])
def test_never_requests_mcp_even_from_sitemaps_or_redirects(options):
    with site(**options) as (origin, hits, _, _):
        result = run(origin, "--json")
    assert result.returncode == 1
    assert "refused /mcp" in result.stdout
    assert not any(CHECK["is_mcp"](origin + path) for path in hits)


def raw_profile(kind, payload):
    encoded = payload.hex().encode()
    return (
        b"\n"
        + kind
        + b"\n"
        + str(len(payload)).encode().rjust(8)
        + b"\n"
        + b"\n".join(encoded[n : n + 72] for n in range(0, len(encoded), 72))
        + b"\n"
    )


@pytest.mark.parametrize("kind", [b"exif", b"xmp", b"APP1", b"8bim", b"other"])
@pytest.mark.parametrize("payload_kind", ["exif", "tiff", "wrapped", "xmp"])
@pytest.mark.parametrize("gps", [False, True])
@pytest.mark.parametrize("chunk", ["text", "ztxt", "itxt", "itxt-compressed"])
def test_imagemagick_raw_profiles(kind, payload_kind, gps, chunk):
    payload = {
        "exif": b"Exif\0\0" + tiff(gps),
        "tiff": tiff(gps),
        "wrapped": b"8BIM\x04\x22\0\0" + struct.pack(">I", len(tiff(gps))) + tiff(gps),
        "xmp": GPS_XMP if gps else PLAIN_XMP,
    }[payload_kind]
    profile = raw_profile(kind, payload)
    keyword = b"Raw profile type " + kind + b"\0"
    if chunk == "text":
        image = png(keyword + profile, b"tEXt")
    elif chunk == "ztxt":
        image = png(keyword + b"\0" + zlib.compress(profile), b"zTXt")
    else:
        compressed = chunk.endswith("compressed")
        image = png(
            keyword
            + bytes([compressed, 0])
            + b"\0\0"
            + (zlib.compress(profile) if compressed else profile),
            b"iTXt",
        )
    assert CHECK["has_location"](image) is gps
    from server.app.image_privacy import strip_location

    assert not CHECK["has_location"](strip_location(image, "image/png"))


@pytest.mark.parametrize(
    "profile", [b"exif\n2\n00", b"exif\n1\nzz", b"wrong\n1\n00", b"exif\n9999999\n00"]
)
@pytest.mark.parametrize("kind", [b"exif", b"APP1", b"8bim", b"other"])
def test_invalid_raw_profiles_are_errors(profile, kind):
    profile = profile.replace(b"exif", kind)
    with pytest.raises(CHECK["CheckError"]):
        CHECK["has_location"](png(b"Raw profile type " + kind + b"\0" + profile, b"tEXt"))


def test_gps_text_scan_is_time_bounded_on_dotted_names():
    code = """import runpy,sys,struct
m=runpy.run_path(sys.argv[1])
payload=b'a.'*32000
assert not m['xmp_location'](payload)
assert m['xmp_location'](payload+b'<exif:GPSLatitude>1</exif:GPSLatitude>')
assert not m['has_location'](b'\\xff\\xd8\\xff\\xe1'+struct.pack('>H',len(payload)+2)+payload+b'\\xff\\xd9')
"""
    result = subprocess.run(
        [sys.executable, "-c", code, str(SCRIPT)], capture_output=True, text=True, timeout=2
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("options", [{"short_page": True}, {"short_media": True}])
def test_short_content_length_is_an_error_not_clean(options):
    with site(**options) as (origin, _, _, _):
        result = run(origin, "--json")
    assert result.returncode == 1 and not result.stderr
    report = json.loads(result.stdout)
    if options.get("short_media"):
        assert report["photos"][0]["location"] == "error"
        assert "short response" in report["photos"][0]["error"]
    else:
        assert "short response" in report["errors"][0]["error"]


@pytest.mark.parametrize(
    "error",
    [
        InvalidURL("bad URL"),
        LineTooLong("header"),
        HTTPException("bad response"),
        IncompleteRead(b"partial", 10),
    ],
)
def test_http_client_exceptions_are_reported_per_url(monkeypatch, error):
    checker = CHECK["Checker"]("https://example.com", delay=0)

    def fail(*args, **kwargs):
        raise error

    monkeypatch.setattr(checker.opener, "open", fail)
    report = checker.scan()
    assert len(report["errors"]) == 2
    assert all("network error:" in item["error"] for item in report["errors"])


@pytest.mark.parametrize("options", [{"long_header": True}, {"space_page": True}])
def test_actual_bad_http_header_or_url_returns_json_not_traceback(options):
    with site(**options) as (origin, _, _, _):
        result = run(origin, "--json")
    assert result.returncode == 1 and "Traceback" not in result.stderr
    assert json.loads(result.stdout)["errors"]
