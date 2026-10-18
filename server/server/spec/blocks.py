"""The site's structured blocks (port of cloudflare/src/blocks.ts): contact,
hours, notice and events made display-ready for themes, in the site's
timezone. Time-dependent answers take `now`, so a page can be made at a fixed
clock."""

import re
from datetime import UTC, datetime
from typing import Any

from .jsutil import add_days, long_day, num, round2, short_day, string, zone_short_name
from .jsutil import local as _local
from .strings import BLOCK_STRINGS
from .public_time_clock import wall

Data = dict[str, Any]


DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DAY_NAMES = {
    "mon": "Monday",
    "tue": "Tuesday",
    "wed": "Wednesday",
    "thu": "Thursday",
    "fri": "Friday",
    "sat": "Saturday",
    "sun": "Sunday",
}


def local_now(now: datetime, tz: str) -> Data:
    """Now, as the site's wall clock: date YYYY-MM-DD, time HH:MM, weekday mon..sun."""
    if now.tzinfo is None:
        now=now.replace(tzinfo=UTC)
    pinned=wall(now.timestamp()*1000,tz)
    if pinned is not None:
        return pinned
    t = _local(now, tz)
    return {"date": t.strftime("%Y-%m-%d"), "time": t.strftime("%H:%M"), "day": DAYS[t.weekday()]}


def clock(hhmm: str) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _at(d: str) -> datetime:
    return datetime.fromisoformat(f"{d}T12:00:00+00:00")


def _weekday_of(d: str) -> str:
    return DAYS[_at(d).weekday()]


def _zone_name(tz: str, at: datetime) -> str:
    return re.sub(r"^([ECMP])[SD]T\Z", r"\1T", zone_short_name(tz, at))


def contact_view(c: Data | None) -> Data:
    c = c or {}
    a = c.get("address") or {}
    city_line = ", ".join(
        x
        for x in [a.get("city"), " ".join(x for x in [a.get("region"), a.get("postcode")] if x)]
        if x
    )
    lines = [x for x in [a.get("line1"), a.get("line2"), city_line, a.get("country")] if x]
    phone = string(c.get("phone"))  # String(c?.phone ?? "")
    social = c.get("social") if c.get("social") is not None else []
    email = c.get("email") if c.get("email") is not None else ""
    return {
        "has": bool(phone or c.get("email") or len(lines) or len(social)),
        "phone": phone,
        "phone_href": f"tel:{re.sub(r'[^+0-9]', '', phone)}" if phone else "",
        "email": email,
        "email_href": f"mailto:{c['email']}" if c.get("email") else "",
        "address_lines": [{"line": line} for line in lines],
        "address_one_line": ", ".join(lines),
        "has_address": len(lines) > 0,
        "map_link": c.get("map_link") if c.get("map_link") is not None else "",
        "social": social,
        "has_social": len(social) > 0,
    }


def _hours_on(h: Data, d: str) -> Data:
    ex = next(
        (x for x in h.get("exceptions") or [] if x["from"] <= d <= (x["to"] or x["from"])), None
    )
    if ex:
        shut = bool(ex["closed"] or not ex["open"])
        return {
            "closed": shut,
            "spans": [] if shut else [{"open": ex["open"], "close": ex["close"]}],
            "label": ex["label"],
        }
    rows = [r for r in h.get("weekly") or [] if r["day"] == _weekday_of(d)]
    spans = [
        {"open": r["open"], "close": r["close"]}
        for r in rows
        if not r["closed"] and r["open"] and r["close"]
    ]
    return {"closed": len(spans) == 0, "spans": spans, "label": ""}


def _span_text(spans: list[Data]) -> str:
    return ", ".join(f"{clock(s['open'])} – {clock(s['close'])}" for s in spans)


def hours_view(h: Data | None, tz: str, now: datetime, t: dict[str, str] = BLOCK_STRINGS) -> Data:
    if not h or not len(h.get("weekly") or []):
        return {
            "has": False,
            "days": [],
            "exceptions": [],
            "has_exceptions": False,
            "open_now": False,
            "status": "",
            "note": "",
        }
    n = local_now(now, tz)
    days = []
    for d in DAYS:
        rows = [
            r for r in h["weekly"] if r["day"] == d and not r["closed"] and r["open"] and r["close"]
        ]
        days.append(
            {
                "day": DAY_NAMES[d],
                "hours": _span_text(rows) if rows else t["closed"],
                "closed": not rows,
                "today": d == n["day"],
            }
        )
    today = _hours_on(h, n["date"])
    current = next((s for s in today["spans"] if s["open"] <= n["time"] < s["close"]), None)
    if current:
        status = f"{t['open_now']} · {t['until']} {clock(current['close'])}"
    else:
        later = next((s for s in today["spans"] if s["open"] > n["time"]), None)
        nxt = clock(later["open"]) if later else ""
        i = 1
        while not nxt and i <= 7:
            d = add_days(n["date"], i)
            o = _hours_on(h, d)
            if not o["closed"]:
                nxt = f"{short_day(d).split(',')[0]} {clock(o['spans'][0]['open'])}"
            i += 1
        status = f"{t['closed_now']} · {t['opens']} {nxt}" if nxt else t["closed_now"]
    horizon = add_days(n["date"], 60)
    shown = [
        x
        for x in h.get("exceptions") or []
        if (x["to"] or x["from"]) >= n["date"] and x["from"] <= horizon
    ]
    shown.sort(key=lambda x: x["from"])
    exceptions = [
        {
            "label": x["label"],
            "when": f"{short_day(x['from'])} – {short_day(x['to'])}"
            if x["to"] and x["to"] != x["from"]
            else short_day(x["from"]),
            "hours": t["closed"]
            if x["closed"] or not x["open"]
            else _span_text([{"open": x["open"], "close": x["close"]}]),
        }
        for x in shown
    ]
    note = h.get("note")
    return {
        "has": True,
        "days": days,
        "exceptions": exceptions,
        "has_exceptions": len(exceptions) > 0,
        "open_now": bool(current),
        "status": status,
        "note": note if note is not None else "",
    }


def notice_view(n: Data | None, tz: str, now: datetime) -> Data:
    n = n or {}
    text = "" if n.get("text") is None else str(n["text"])
    shown = bool(text) and (not n.get("until") or n["until"] >= local_now(now, tz)["date"])
    return {"has": shown, "text": text if shown else ""}


class EventMemo:
    """Pure display components owned by one render, never shared between requests."""

    def __init__(self):
        self.longs = {}
        self.shorts = {}
        self.zones = {}
        self.clocks = {}
        self.walls = {}

    # Locale and formatting options are fixed by long_day/short_day themselves.
    def long(self, day):
        if day not in self.longs:
            self.longs[day] = long_day(day)
        return self.longs[day]

    def short(self, day):
        if day not in self.shorts:
            self.shorts[day] = short_day(day)
        return self.shorts[day]

    def zone(self, tz, day):
        key = (tz, day)
        if key not in self.zones:
            self.zones[key] = _zone_name(tz, _at(day))
        return self.zones[key]

    def clock(self, value):
        if value not in self.clocks:
            self.clocks[value] = clock(value)
        return self.clocks[value]

    def local(self, now, tz):
        reference = now if now.tzinfo is not None else now.replace(tzinfo=UTC)
        key = (tz, reference.timestamp())
        if key not in self.walls:
            self.walls[key] = local_now(now, tz)
        return self.walls[key]


def event_view(ev: Data | None, tz: str, now: datetime, t: dict[str, str] = BLOCK_STRINGS, memo: EventMemo | None = None) -> Data:
    if not ev:
        return {"has": False}
    n = memo.local(now, tz) if memo is not None else local_now(now, tz)
    long_label = memo.long if memo is not None else long_day
    short_label = memo.short if memo is not None else short_day
    clock_text = memo.clock if memo is not None else clock
    now_stamp = f"{n['date']}T{n['time']}"
    sd, st = ev["start"].split("T")
    ed, et = ev["end"].split("T") if ev["end"] else (sd, "")
    zone = memo.zone(tz, sd) if memo is not None else _zone_name(tz, _at(sd))
    time = f"{clock_text(st)} – {clock_text(et)} {zone}" if et and ed == sd else f"{clock_text(st)} {zone}"
    when = (
        f"{long_label(sd)}, {clock_text(st)} – {long_label(ed)}, {clock_text(et)} {zone}"
        if ed != sd and ev["end"]
        else f"{long_label(sd)} · {time}"
    )
    place = ev.get("place") or {}
    rsvp = ev.get("rsvp") or {}
    schedule = ev.get("schedule") or []
    status = ev.get("status")
    return {
        "has": True,
        "when": when,
        "date_long": long_label(sd),
        "date_short": short_label(sd),
        "time": time,
        "is_past": (ev["end"] or ev["start"]) < now_stamp,
        "place_name": place.get("name", ""),
        "place_address": place.get("address", ""),
        "map_link": place.get("map_link", ""),
        "rsvp_label": rsvp.get("label") or "",
        "rsvp_link": rsvp.get("link") or "",
        "rsvp_deadline": f"{t['rsvp_by']} {long_label(rsvp['deadline'])}"
        if rsvp.get("deadline")
        else "",
        "schedule": [
            {"time": clock_text(s["time"]), "title": s["title"], "note": s["note"]} for s in schedule
        ],
        "has_schedule": len(schedule) > 0,
        "status": t["cancelled"]
        if status == "cancelled"
        else t["changed"]
        if status == "changed"
        else "",
        "is_cancelled": status == "cancelled",
        "is_changed": status == "changed",
        "start": ev["start"],
    }


# --- palettes -------------------------------------------------------------------------

PALETTE_KEYS = ["bg", "ink", "muted", "accent", "accent-2", "line", "on-accent"]


def _luminance(hex_: str) -> float:
    n = hex_.replace("#", "", 1)
    r, g, b = (int(n[i : i + 2], 16) / 255 for i in (0, 2, 4))
    r, g, b = (c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in (r, g, b))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    x, y = sorted([_luminance(a), _luminance(b)], reverse=True)
    return round2((x + 0.05) / (y + 0.05))


def palette_problems(palettes: Any = ...) -> list[str]:
    """Problems with a theme's palettes (`...` stands for undefined)."""
    if palettes is ...:
        return []
    out: list[str] = []
    if not palettes or not isinstance(palettes, dict):
        return ["palettes: an object of {name: {title, colors}}"]
    for name, p in palettes.items():
        if not re.search(r"^[a-z][a-z0-9-]{0,29}\Z", name):
            out.append(f"palette {name}: names are lowercase-with-dashes")
        if not (isinstance(p, dict) and p.get("title")):
            out.append(f"palette {name}: needs a title")
        c = (p.get("colors") if isinstance(p, dict) else None) or {}
        for k in PALETTE_KEYS:
            v = c.get(k) if isinstance(c, dict) else None
            if not re.search(r"^#[0-9a-fA-F]{6}\Z", "" if v is None else str(v)):
                out.append(f"palette {name}: colors.{k} must be a #rrggbb colour")
        if any(x.startswith(f"palette {name}: colors.") for x in out):
            continue
        for fg, bg, least in [
            ("ink", "bg", 4.5),
            ("muted", "bg", 4.5),
            ("accent", "bg", 3),
            ("on-accent", "accent", 4.5),
        ]:
            r = contrast(c[fg], c[bg])
            if r < least:
                out.append(f"palette {name}: {fg} on {bg} is {num(r)}:1, needs {num(least)}:1")
    return out


def palette_css(palettes: Data | None, chosen: str) -> str:
    """The palette's colours as CSS variables, appended after the theme's own stylesheet."""
    if not palettes:
        return ""
    p = palettes.get(chosen)
    if p is None:  # palettes[chosen] ?? Object.values(palettes)[0]
        p = next(iter(palettes.values()), None)
    if not (isinstance(p, dict) and p.get("colors")):
        return ""
    return (
        "\n:root{"
        + ";".join(
            f"--{k}:{string(p['colors'].get(k)) if k in p['colors'] else 'undefined'}"
            for k in PALETTE_KEYS
        )
        + "}\n"
    )
