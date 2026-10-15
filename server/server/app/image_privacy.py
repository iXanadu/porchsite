"""Remove location metadata without decoding pixels or following EXIF pointers."""

import re
import struct
import zlib

from .errors import ApiError


def _bad():
    raise ApiError(422, "invalid", "The picture's metadata is damaged. Try a fresh copy.")


def _orientation(data: bytes) -> int | None:
    b = memoryview(data)[6:] if data[:6] == b"Exif\0\0" else memoryview(data)
    if len(b) < 8 or bytes(b[:2]) not in (b"II", b"MM"):
        return None
    order = "<" if b[0] == 73 else ">"
    if struct.unpack_from(order + "H", b, 2)[0] != 42:
        return None
    at = struct.unpack_from(order + "I", b, 4)[0]
    if at < 8 or at > len(b) - 2:
        return None
    count = struct.unpack_from(order + "H", b, at)[0]
    if count > 64 or at + 2 + count * 12 + 4 > len(b):
        return None
    for n in range(count):
        i = at + 2 + n * 12
        tag, type_, length = struct.unpack_from(order + "HHI", b, i)
        if tag == 0x112 and type_ == 3 and length == 1:
            value = struct.unpack_from(order + "H", b, i + 8)[0]
            if 1 <= value <= 8:
                return value
    return None


def _tiff(value: int) -> bytes:
    return bytes(
        [73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, value, 0, 0, 0, 0, 0, 0, 0]
    )


def _edit(edits, b, start, end, replacement=b""):
    if b[start:end] != replacement:
        edits.append((start, end, replacement))


def _apply(b, edits):
    if not edits:
        return b
    parts = []
    start = 0
    view = memoryview(b)
    for a, z, replacement in sorted(edits):
        parts.extend((view[start:a], replacement))
        start = z
    parts.append(view[start:])
    return b"".join(parts)


def _safe_tail(b, start, names):
    # A native fixed-byte search neither copies nor decodes the picture.
    for name in names:
        if b.find(name, start) >= 0:
            _bad()


def _jpeg(b):
    edits = []
    at, segments = 2, 0
    while at < len(b):
        start = b.find(b"\xff", at)
        if start < 0:
            break
        marker = start + 1
        while marker < len(b) and b[marker] == 255:
            if marker - start > 4096:
                _bad()
            marker += 1
        if marker >= len(b):
            break
        code = b[marker]
        if code in (0, 1) or 0xD0 <= code <= 0xD9:
            at = marker + 1
            continue
        segments += 1
        if segments > 4096:
            _bad()
        meta = code in (0xE1, 0xED, 0xFE)
        if marker + 2 >= len(b):
            if meta:
                _bad()
            break
        length = int.from_bytes(b[marker + 1 : marker + 3], "big")
        end = marker + 1 + length
        if length < 2 or end > len(b):
            if meta:
                _bad()
            _safe_tail(b, marker + 1, [b"\xff\xe1", b"\xff\xed", b"\xff\xfe"])
            break
        payload = b[marker + 3 : end]
        if code == 0xE1:
            value = _orientation(payload) if payload.startswith(b"Exif\0\0") else None
            replacement = b"" if value is None else b"\xff\xe1\0\x22Exif\0\0" + _tiff(value)
            _edit(edits, b, start, end, replacement)
        elif code in (0xED, 0xFE):
            _edit(edits, b, start, end)
        at = end
    return _apply(b, edits)


def _png_exif(value):
    payload = b"eXIf" + _tiff(value)
    return struct.pack(">I", 26) + payload + struct.pack(">I", zlib.crc32(payload))


def _png(b):
    edits = []
    at, chunks = 8, 0
    names = [b"eXIf", b"tEXt", b"iTXt", b"zTXt"]
    while at + 8 <= len(b):
        chunks += 1
        if chunks > 4096:
            _bad()
        name = b[at + 4 : at + 8]
        length = int.from_bytes(b[at : at + 4], "big")
        end = at + 12 + length
        if end > len(b) or not re.fullmatch(b"[A-Za-z]{4}", name):
            if name in names:
                _bad()
            _safe_tail(b, at, names)
            break
        if name in names:
            value = _orientation(b[at + 8 : end - 4]) if name == b"eXIf" else None
            _edit(edits, b, at, end, b"" if value is None else _png_exif(value))
        at = end
    if at < len(b):
        _safe_tail(b, at, names)
    return _apply(b, edits)


def _webp(b):
    edits, flags = [], []
    at, chunks, has_exif, metadata = 12, 0, False, False
    names = [b"EXIF", b"XMP "]
    while at + 8 <= len(b):
        chunks += 1
        if chunks > 4096:
            _bad()
        name = b[at : at + 4]
        length = int.from_bytes(b[at + 4 : at + 8], "little")
        end = at + 8 + length + length % 2
        if end > len(b) or not re.fullmatch(b"[A-Za-z0-9 ]{4}", name):
            if name in names:
                _bad()
            _safe_tail(b, at, names)
            break
        if name == b"VP8X" and length >= 10:
            flags.append(at + 8)
        if name in names:
            metadata = True
            value = _orientation(b[at + 8 : at + 8 + length]) if name == b"EXIF" else None
            replacement = b""
            if value is not None:
                has_exif = True
                replacement = b"EXIF\x1a\0\0\0" + _tiff(value)
            _edit(edits, b, at, end, replacement)
        at = end
    if at < len(b):
        _safe_tail(b, at, names)
    if metadata:
        for offset in flags:
            _edit(edits, b, offset, offset + 1, bytes([(b[offset] & ~12) | (8 if has_exif else 0)]))
    out = _apply(b, edits)
    if out is not b:
        out = out[:4] + struct.pack("<I", len(out) - 8) + out[8:]
    return out


def strip_location(data: bytes, type_: str) -> bytes:
    if type_ == "image/jpeg":
        return _jpeg(data)
    if type_ == "image/png":
        return _png(data)
    if type_ == "image/webp":
        return _webp(data)
    return data
