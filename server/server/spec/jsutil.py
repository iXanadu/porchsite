"""JavaScript semantics the Cloudflare edition leans on, so the port gives the
same answers: whitespace and trim as ECMAScript defines them, string lengths
in UTF-16 code units, en-US date formatting, URL hosts, locale-aware compare
and how a value becomes a string.
"""

import math
import re
import unicodedata
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# ECMAScript WhiteSpace + LineTerminator: what \s matches and trim() strips.
WS = "\t\n\v\f\r    -     　﻿"
S = f"[{WS}]"  # \s
NOT_S = f"[^{WS}]"  # \S
_WS_CHARS = "".join(
    chr(c)
    for c in [
        9,
        10,
        11,
        12,
        13,
        32,
        0xA0,
        0x1680,
        *range(0x2000, 0x200B),
        0x2028,
        0x2029,
        0x202F,
        0x205F,
        0x3000,
        0xFEFF,
    ]
)
WS_CHARS = frozenset(_WS_CHARS)  # the characters \s matches
DOT = "[^\n\r  ]"  # . without the s flag


def trim(s: str) -> str:
    return s.strip(_WS_CHARS)


def u16len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def u16slice(s: str, start: int, end: int) -> str:
    """s.slice(start, end) for non-negative bounds (a split pair is dropped
    whole on the right; JS would keep a lone surrogate, which can't be written
    as UTF-8 anyway)."""
    b = s.encode("utf-16-le", "surrogatepass")[start * 2 : end * 2]
    return b.decode("utf-16-le", "ignore")


def test(pattern: str, s: str) -> bool:
    """RegExp.prototype.test for a ^...$ pattern written with \\Z for $."""
    return re.search(pattern, s) is not None


# --- dates ---------------------------------------------------------------------------

MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def day_of(d: str) -> date:
    """new Date(`${d}T12:00:00Z`), as a calendar date (UTC)."""
    return date.fromisoformat(d)


def short_date(d: str) -> str:
    """{month: short, day: numeric}: Oct 8"""
    x = day_of(d)
    return f"{MONTHS[x.month - 1][:3]} {x.day}"


def long_date(d: str) -> str:
    """{month: long, day: numeric, year: numeric}: October 8, 2026"""
    x = day_of(d)
    return f"{MONTHS[x.month - 1]} {x.day}, {x.year}"


def long_day(d: str) -> str:
    """{weekday: long, month: long, day: numeric, year: numeric}: Friday, June 11, 2027"""
    x = day_of(d)
    return f"{WEEKDAYS[x.weekday()]}, {MONTHS[x.month - 1]} {x.day}, {x.year}"


def short_day(d: str) -> str:
    """{weekday: short, month: short, day: numeric}: Fri, Jun 11"""
    x = day_of(d)
    return f"{WEEKDAYS[x.weekday()][:3]}, {MONTHS[x.month - 1][:3]} {x.day}"


def add_days(d: str, n: int) -> str:
    return (day_of(d) + timedelta(days=n)).isoformat()


def zone(tz: str) -> ZoneInfo:
    return ZoneInfo(tz)


def valid_zone(tz: str) -> bool:
    try:
        ZoneInfo(tz)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


def local(now: datetime, tz: str) -> datetime:
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    return now.astimezone(ZoneInfo(tz))


# The short names en-US gives (ICU metazones with English abbreviations), with
# the UTC offset each stands for; any other zone reads GMT+H[:MM].
_US_NAMES = {
    "EST": -300,
    "EDT": -240,
    "CST": -360,
    "CDT": -300,
    "MST": -420,
    "MDT": -360,
    "PST": -480,
    "PDT": -420,
    "AKST": -540,
    "AKDT": -480,
    "HST": -600,
    "HDT": -540,
    "AST": -240,
    "ADT": -180,
}


def zone_short_name(tz: str, at: datetime) -> str:
    """Intl.DateTimeFormat("en-US", {timeZone, timeZoneName: "short"})'s name."""
    if tz.upper() in (
        "UTC",
        "ETC/UTC",
        "ETC/UCT",
        "UCT",
        "ETC/UNIVERSAL",
        "UNIVERSAL",
        "ETC/ZULU",
        "ZULU",
    ):
        return "UTC"
    t = local(at, tz)
    off = t.utcoffset() or timedelta(0)
    minutes = int(off.total_seconds() // 60)
    abbr = t.tzname() or ""
    if _US_NAMES.get(abbr) == minutes:
        return abbr
    if minutes == 0:
        return "GMT"
    sign = "+" if minutes > 0 else "-"
    h, m = divmod(abs(minutes), 60)
    return f"GMT{sign}{h}" + (f":{m:02d}" if m else "")


# --- URLs ----------------------------------------------------------------------------

_SPECIAL_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21, "file": None}


def url_host(u: str) -> str | None:
    """new URL(u).host, or None where new URL throws."""
    u = u.strip(" \t\n\r\x0c\x00")
    m = re.match(r"([A-Za-z][A-Za-z0-9+.-]*):", u)
    if not m:
        return None
    scheme = m.group(1).lower()
    if scheme not in _SPECIAL_PORTS:
        # Opaque or authority-bearing non-special URL.
        rest = u[m.end() :]
        if not rest.startswith("//"):
            return ""
    try:
        parts = urlsplit(u)
        hostname = parts.hostname or ""
        port = parts.port
    except ValueError:
        return None
    if scheme in _SPECIAL_PORTS and scheme != "file" and not hostname:
        return None
    try:
        hostname = (
            hostname.encode("idna").decode("ascii")
            if hostname and not hostname.isascii()
            else hostname
        )
    except UnicodeError:
        return None
    if port is not None and port != _SPECIAL_PORTS.get(scheme):
        return f"{hostname}:{port}"
    return hostname


# --- compare -------------------------------------------------------------------------


def _collate_char(c: str) -> tuple[int, Any]:
    if c in _WS_CHARS:
        return (0, ord(c))
    if c.isdigit():
        return (2, unicodedata.digit(c, 0))
    if c.isalpha():
        return (3, c.casefold())
    return (1, ord(c))


def collate_key(s: str) -> tuple:
    """A sort key close to String.prototype.localeCompare (ICU root collation):
    spaces, then punctuation, digits, letters; case and accents only break ties,
    lowercase first."""
    nfd = unicodedata.normalize("NFD", s)
    primary, secondary, tertiary = [], [], []
    for c in nfd:
        if unicodedata.combining(c):
            if secondary:
                secondary[-1] += (ord(c),)
            continue
        primary.append(_collate_char(c))
        secondary.append(())
        tertiary.append(1 if c != c.lower() else 0)
    return (primary, secondary, tertiary)


def locale_compare(a: str, b: str) -> int:
    ka, kb = collate_key(a), collate_key(b)
    return (ka > kb) - (ka < kb)


def u16key(s: str) -> bytes:
    """Default Array.prototype.sort order: UTF-16 code units."""
    return s.encode("utf-16-be", "surrogatepass")


# --- values --------------------------------------------------------------------------


def num(n: float | int) -> str:
    """Number.prototype.toString for the numbers a page shows."""
    if isinstance(n, bool):
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if math.isnan(n):
        return "NaN"
    if math.isinf(n):
        return "Infinity" if n > 0 else "-Infinity"
    if n == int(n) and abs(n) < 1e21:
        return str(int(n))
    return repr(n)


def string(v: Any) -> str:
    """String(v), as Mustache shows a value."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, bool | int | float):
        return num(v)
    if isinstance(v, list):
        return ",".join("" if x is None else string(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


def round2(x: float) -> float:
    """Math.round(x * 100) / 100"""
    return math.floor(x * 100 + 0.5) / 100
