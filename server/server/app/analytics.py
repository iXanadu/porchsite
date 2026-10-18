"""First-party visitor analytics (SPEC §8): collect page views, report on
them. Port of cloudflare/src/analytics.ts; see its docstring for the rules.

Nothing here identifies a person. A visitor is sha256(salt + IP + user agent)
where the salt is random, belongs to one day, and is deleted once the day is
over. The IP itself is never stored. Every number is worked out here from the
raw rows, the same way in both editions.
"""

import hashlib
import json
import math
import re
import secrets

import asyncpg
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from server.spec.jsutil import add_days, local, u16slice, url_host

from .agent_traffic import traffic_report
from .content import site_data
from .db import Db, iso, transaction

NOTRACK_COOKIE = "sk_nt"
RETAIN_DAYS = 90
DAILY_VIEW_CAP = 200
MAX_BODY = 2048
MAX_ENGAGED_MS = 4 * 3600 * 1000
BOUNCE_MS = 10_000

KINDS = {"home", "entry", "archive", "tag", "notfound", "other"}
_ID = re.compile(r"[A-Za-z0-9_-]{8,64}")
_SRC = re.compile(r"[a-z0-9_-]{1,20}")
_POST = re.compile(r"[A-Za-z0-9_-]{1,40}")
_CONTENT = re.compile(r"[a-z]{2,8}_[A-Za-z0-9]{4,40}")
_BOT = re.compile(
    r"bot|crawl|spider|slurp|headless|phantom|lighthouse|pagespeed|preview|scanner|"
    r"facebookexternalhit|embedly|quora link|outbrain|pinterest/|vkshare|w3c_validator|"
    r"curl|wget|python-|httpx|go-http|java/|okhttp|axios|node-fetch|monitor|uptime",
    re.I,
)
_SEARCH = (
    "google.",
    "bing.com",
    "duckduckgo.com",
    "search.yahoo.",
    "yandex.",
    "ecosia.org",
    "search.brave.com",
    "baidu.com",
    "kagi.com",
    "startpage.com",
)
_X = ("t.co", "x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com")

# The not-tracked cookie, set on the collect path only, for about 400 days.
NOTRACK_SET = (
    f"{NOTRACK_COOKIE}=1; Path=/collect; HttpOnly; Secure; SameSite=Lax; Max-Age={400 * 86400}"
)


def is_bot(ua: str) -> bool:
    return not ua or bool(_BOT.search(ua))


def local_day(now: datetime, tz: str) -> str:
    """YYYY-MM-DD on the site's clock."""
    return local(now, tz).date().isoformat()


async def _today(db: Db, now: datetime) -> str:
    return local_day(now, str((await site_data(db, True)).get("timezone") or "UTC"))


async def _salt(db: Db, day: str) -> str:
    await db.execute(
        "INSERT INTO analytics_salts (day, salt) VALUES ($1, $2) ON CONFLICT (day) DO NOTHING",
        day,
        secrets.token_hex(32),
    )
    return await db.fetchval("SELECT salt FROM analytics_salts WHERE day = $1", day)


async def visitor_hash(db: Db, day: str, ip: str, ua: str) -> str:
    s = await _salt(db, day)
    return hashlib.sha256(f"{s}{ip}\n{ua}".encode()).hexdigest()[:32]


def referrer(ref: str, host: str) -> tuple[str, str, str]:
    """(bucket, domain, previous path on this site) for a document.referrer."""
    if not ref:
        return "direct", "", ""
    h = url_host(ref)  # None where new URL() throws
    if h is None:
        return "other", "", ""
    hostname = re.sub(r":\d+\Z", "", h)
    domain = re.sub(r"^www\.", "", hostname.lower())
    if not domain:
        return "direct", "", ""
    if domain == re.sub(r"^www\.", "", host.lower()):
        return "internal", "", u16slice(urlsplit(ref).path or "/", 0, 300)
    if domain in _X:
        return "x", domain, ""
    if any(domain.startswith(s) or f".{s}" in f".{domain}" for s in _SEARCH):
        return "search", domain, ""
    return "other", u16slice(domain, 0, 100), ""


def _str(v: Any, limit: int) -> str:
    return u16slice(v, 0, limit) if isinstance(v, str) else ""


def _int(v: Any) -> int:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return 0
    if isinstance(v, float) and not math.isfinite(v):
        return 0
    return int(v)


async def _maintain(db: Db, day: str) -> str:
    try:
        return await _maintenance(db, day, True)
    except asyncpg.UndefinedTableError as error:
        if '"analytics_visitor_counts"' not in str(error):
            raise
        # PostgreSQL rolled back the failed cleanup transaction before retry.
        return await _maintenance(db, day, False)


async def _maintenance(db: Db, day: str, counters: bool) -> str:
    marker = await db.fetchval("SELECT completed_day FROM analytics_maintenance WHERE id = 1")
    if marker is None:
        raise RuntimeError("analytics maintenance unavailable")
    if marker >= day:
        return marker
    cutoff = add_days(day, -RETAIN_DAYS)
    async with transaction(db) as c:
        marker = await c.fetchval("SELECT completed_day FROM analytics_maintenance WHERE id = 1 FOR UPDATE")
        if marker is None:
            raise RuntimeError("analytics maintenance unavailable")
        if marker >= day:
            return marker
        await c.execute("DELETE FROM analytics_salts WHERE day < $1 AND EXISTS (SELECT 1 FROM analytics_maintenance WHERE id = 1 AND completed_day < $1)", day)
        await c.execute(
            "INSERT INTO analytics_daily (day, visits, views, engaged_ms)"
            " SELECT day, count(DISTINCT visitor), count(*), sum(engaged_ms) FROM pageviews"
            " WHERE day < $1 AND NOT test AND EXISTS (SELECT 1 FROM analytics_maintenance WHERE id = 1 AND completed_day < $2)"
            " GROUP BY day ON CONFLICT (day) DO NOTHING", cutoff, day,
        )
        await c.execute("DELETE FROM pageviews WHERE day < $1 AND EXISTS (SELECT 1 FROM analytics_maintenance WHERE id = 1 AND completed_day < $2)", cutoff, day)
        if counters:
            await c.execute("DELETE FROM analytics_visitor_counts WHERE day < $1 AND EXISTS (SELECT 1 FROM analytics_maintenance WHERE id = 1 AND completed_day < $2)", cutoff, day)
        await c.execute("UPDATE analytics_maintenance SET completed_day = $1 WHERE id = 1 AND completed_day < $1", day)
    return day


async def collect(
    db: Db, raw: bytes, *, ip: str, ua: str, notrack: bool, host: str, now: datetime | None = None
) -> bool:
    try:
        return await _record(db, raw, ip=ip, ua=ua, notrack=notrack, host=host, now=now)
    except Exception:
        return False


async def _record(
    db: Db, raw: bytes, *, ip: str, ua: str, notrack: bool, host: str, now: datetime | None = None
) -> bool:
    """Accept one beacon event. Unchanged heartbeats need no write; never raises
    for bad input (the beacon can't do anything with an error)."""
    if len(raw) > MAX_BODY or notrack:
        return False
    try:
        ev = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return False
    if not isinstance(ev, dict) or not isinstance(ev.get("id"), str) or not _ID.fullmatch(ev["id"]):
        return False
    now = now or datetime.now(UTC)
    at = iso(now)
    if ev.get("t") == "pv":
        # Bots are stopped here; a heartbeat only ever updates a view that got in.
        if is_bot(ua):
            return False
        path = _str(ev.get("p"), 300)
        if not path.startswith("/") or path.startswith(("/review", "/mcp", "/collect")):
            return False
        day = await _today(db, now)
        horizon = await _maintain(db, day)
        visitor = await visitor_hash(db, day, ip, ua)
        counters = day >= add_days(horizon, -RETAIN_DAYS)
        if counters:
            try:
                counter = await db.fetchrow("SELECT c.views, m.completed_day FROM analytics_visitor_counts c JOIN analytics_maintenance m ON m.id = 1 WHERE c.day = $1 AND c.visitor = $2", day, visitor)
            except asyncpg.UndefinedTableError as error:
                if '"analytics_visitor_counts"' not in str(error):
                    raise
                counters = False
            else:
                if counter is not None:
                    views = counter["views"]
                    counters = day >= add_days(counter["completed_day"], -RETAIN_DAYS) and type(views) is int and 0 <= views <= DAILY_VIEW_CAP
                    if counters and views == DAILY_VIEW_CAP:
                        return False
        kind = _str(ev.get("k"), 20)
        content_id = _str(ev.get("c"), 60)
        src = _str(ev.get("s"), 20).lower()
        post = _str(ev.get("q"), 40)
        bucket, domain, prev = referrer(_str(ev.get("r"), 500), host)
        # The X app often sends no referrer at all; a tagged link still says where.
        if src == "x" and bucket in ("direct", "other"):
            bucket = "x"
        # Lock acquisition is a separate statement, so the subsequent READ
        # COMMITTED insert sees its predecessor's committed final-slot write.
        lock = int.from_bytes(hashlib.sha256(f"AN-1\0{day}\0{visitor}".encode()).digest()[:8], "big", signed=True)
        async with transaction(db) as c:
            await c.execute("SELECT pg_advisory_xact_lock($1)", lock)
            if counters:
                await c.execute(
                    "INSERT INTO analytics_visitor_counts (day, visitor, views)"
                    " SELECT $1, $2, (SELECT count(*) FROM (SELECT 1 FROM pageviews WHERE day = $1 AND visitor = $2 LIMIT 200) counted)"
                    " WHERE NOT EXISTS (SELECT 1 FROM pageviews WHERE id = $3)"
                    " ON CONFLICT (day, visitor) DO UPDATE SET views = excluded.views"
                    " WHERE analytics_visitor_counts.views < excluded.views", day, visitor, ev["id"],
                )
            cap = (
                " WHERE EXISTS (SELECT 1 FROM analytics_visitor_counts WHERE day = $2 AND visitor = $3 AND views < 200)"
                if counters else
                " WHERE NOT EXISTS (SELECT 1 FROM pageviews WHERE day = $2 AND visitor = $3 LIMIT 1 OFFSET 199)"
            )
            status = await c.execute(
                "INSERT INTO pageviews (id, day, visitor, path, kind, content_id, ref_bucket, ref_domain,"
                " prev_path, src, post, test, created_at, updated_at)"
                " SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13"
                + cap + " ON CONFLICT (id) DO NOTHING",
                ev["id"],
                day,
                visitor,
                path,
                kind if kind in KINDS else "other",
                content_id if _CONTENT.fullmatch(content_id) else "",
                bucket,
                domain,
                prev,
                src if _SRC.fullmatch(src) else "",
                post if src and _POST.fullmatch(post) else "",
                ev.get("w") in (1, True),
                at,
            )
            inserted = status.endswith(" 1")
            if counters and inserted:
                await c.execute("UPDATE analytics_visitor_counts SET views = views + 1 WHERE day = $1 AND visitor = $2 AND views < 200", day, visitor)
            return inserted
    if ev.get("t") == "hb":
        engaged = max(0, min(_int(ev.get("e")), MAX_ENGAGED_MS))
        scroll = max(0, min(_int(ev.get("d")), 100))
        # Matched on the page view's id alone: it is random and only the
        # reader's browser knows it, and a phone that moves from Wi-Fi to
        # cellular mid-read has a new address. Never more engaged time than
        # wall time since the view began (plus slack for clock skew).
        since = iso(now - timedelta(hours=6))
        row = await db.fetchrow(
            "SELECT created_at, engaged_ms, max_scroll FROM pageviews WHERE id = $1 AND created_at > $2",
            ev["id"],
            since,
        )
        if not row:
            return False
        began = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
        wall = int((now - began) / timedelta(milliseconds=1)) + 5000
        # Use the current row's maxima, not the earlier SELECT's snapshot.
        # A no-progress heartbeat is accepted without an updated_at-only write.
        await db.execute(
            "UPDATE pageviews SET engaged_ms = GREATEST(engaged_ms, $1),"
            " max_scroll = GREATEST(max_scroll, $2), updated_at = $3"
            " WHERE id = $4 AND (engaged_ms < $1 OR max_scroll < $2)",
            min(engaged, wall),
            scroll,
            at,
            ev["id"],
        )
        return True
    return False


# --- reports -------------------------------------------------------------------------


def pct(n: int, d: int) -> float | int:
    """100 * n / d to one decimal, halves up; 0 when d is 0 (whole numbers as ints, as JSON.stringify writes them)."""
    if not d:
        return 0
    v = ((2000 * n + d) // (2 * d)) / 10
    return int(v) if v == int(v) else v


def _median(xs: list[int]) -> float:
    """The middle value (the mean of the two middle ones for an even count), as PERCENTILE_CONT(0.5)."""
    if not xs:
        return 0
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


async def stats(
    db: Db,
    *,
    days: int = 7,
    content_id: str | None = None,
    src: str | None = None,
    post: str | None = None,
    include_test: bool = False,
    top: int = 20,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Everything the /review/stats page and the site_stats tool show."""
    days = max(1, min(int(days), RETAIN_DAYS))
    end = await _today(db, now or datetime.now(UTC))
    start = add_days(end, -(days - 1))
    rows = [
        dict(r)
        for r in await db.fetch(
            "SELECT * FROM pageviews WHERE day BETWEEN $1 AND $2"
            + ("" if include_test else " AND NOT test")
            + ' ORDER BY created_at, id COLLATE "C"',
            start,
            end,
        )
    ]

    def key(r: dict[str, Any]) -> tuple[str, str]:
        return (r["day"], r["visitor"])

    # Narrowing to one entry or one tagged post: the visits that touched it.
    if content_id or src or post:
        keep = {
            key(r)
            for r in rows
            if (not content_id or r["content_id"] == content_id)
            and (not src or r["src"] == src)
            and (not post or r["post"] == post)
        }
        rows = [r for r in rows if key(r) in keep]

    visits: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        v = visits.get(key(r))
        if v is None:
            v = {
                "day": r["day"],
                "pages": 0,
                "engaged": 0,
                "scroll": 0,
                "landing": r["path"],
                "ref": r["ref_bucket"],
                "domain": r["ref_domain"],
                "exit": r["path"],
                "tags": {},
            }
            visits[key(r)] = v
        v["pages"] += 1
        v["engaged"] += r["engaged_ms"]
        v["scroll"] = max(v["scroll"], r["max_scroll"])
        v["exit"] = r["path"]
        if r["src"]:
            v["tags"][(r["src"], r["post"])] = True
    every = list(visits.values())

    def bounced(v: dict[str, Any]) -> bool:
        return v["engaged"] < BOUNCE_MS or (v["pages"] == 1 and v["scroll"] < 25)

    by_day: dict[str, list] = {}
    for v in every:
        by_day.setdefault(v["day"], []).append(v)
    daily = [
        {
            "day": d,
            "visits": len(vs),
            "views": sum(v["pages"] for v in vs),
            "engaged_ms": sum(v["engaged"] for v in vs),
        }
        for d, vs in sorted(by_day.items())
    ]

    landing: dict[str, dict[str, int]] = {}
    exits: dict[str, int] = {}
    for v in every:
        lv = landing.setdefault(v["landing"], {"visits": 0, "bounces": 0})
        lv["visits"] += 1
        if bounced(v):
            lv["bounces"] += 1
        exits[v["exit"]] = exits.get(v["exit"], 0) + 1

    by_path: dict[str, list] = {}
    for r in rows:
        by_path.setdefault(r["path"], []).append(r)
    page_rows = sorted(
        ({"path": p, "rs": rs, "readers": len({key(r) for r in rs})} for p, rs in by_path.items()),
        key=lambda x: (-x["readers"], -len(x["rs"]), x["path"]),
    )[:top]
    titles: dict[str, str] = {}
    for p in page_rows:
        cid = max((r["content_id"] for r in p["rs"]), default="")
        if cid and cid not in titles:
            data = await db.fetchval("SELECT data FROM items WHERE id = $1", cid)
            if data is not None:
                d = json.loads(data)
                t = d.get("title") if d.get("title") is not None else d.get("name")
                titles[cid] = "" if t is None else str(t)

    def reached(rs: list, k: int) -> float | int:
        return pct(sum(1 for r in rs if r["max_scroll"] >= k), len(rs))

    pages = []
    for p in page_rows:
        rs, path = p["rs"], p["path"]
        cid = max((r["content_id"] for r in rs), default="")
        lv = landing.get(path)
        pages.append(
            {
                "path": path,
                "kind": max((r["kind"] for r in rs), default=""),
                "content_id": cid or None,
                "title": titles.get(cid),
                "readers": p["readers"],
                "views": len(rs),
                "median_engaged_ms": math.trunc(_median([r["engaged_ms"] for r in rs])),
                "mean_engaged_ms": math.trunc(sum(r["engaged_ms"] for r in rs) / len(rs)),
                "reached": {k: reached(rs, int(k)) for k in ("25", "50", "75", "100")},
                "landings": lv["visits"] if lv else 0,
                "bounce_rate": pct(lv["bounces"], lv["visits"]) if lv else None,
                "exits": exits.get(path, 0),
            }
        )

    by_source: dict[str, list] = {}
    for v in every:
        by_source.setdefault(v["ref"], []).append(v)
    sources = sorted(
        (
            {"source": s, "visits": len(vs), "engaged_ms": sum(v["engaged"] for v in vs)}
            for s, vs in by_source.items()
        ),
        key=lambda x: (-x["visits"], x["source"]),
    )
    by_domain: dict[str, int] = {}
    for v in every:
        if v["domain"]:
            by_domain[v["domain"]] = by_domain.get(v["domain"], 0) + 1
    referring = sorted(
        ({"domain": d, "visits": n} for d, n in by_domain.items()),
        key=lambda x: (-x["visits"], x["domain"]),
    )[:15]
    by_tag: dict[tuple[str, str], list] = {}
    for v in every:
        for t in v["tags"]:
            by_tag.setdefault(t, []).append(v)
    tagged = sorted(
        (
            {
                "src": s,
                "post": p or None,
                "visits": len(vs),
                "visit_engaged_ms": sum(v["engaged"] for v in vs),
            }
            for (s, p), vs in by_tag.items()
        ),
        key=lambda x: (-x["visits"], x["src"], x["post"] or ""),
    )[:30]

    # Earlier, counts only: days past their 90 days, by month, newest first (the whole site only).
    earlier = (
        []
        if content_id or src or post
        else [
            {
                "month": r["month"],
                "visits": int(r["visits"]),
                "views": int(r["views"]),
                "engaged_ms": int(r["engaged_ms"]),
            }
            for r in await db.fetch(
                "SELECT substr(day, 1, 7) AS month, sum(visits) AS visits, sum(views) AS views,"
                " sum(engaged_ms) AS engaged_ms FROM analytics_daily GROUP BY 1 ORDER BY 1 DESC"
            )
        ]
    )

    return {
        "agent_traffic": await traffic_report(db,start,end),
        "range": {"start": start, "end": end},
        "filter": {
            "content_id": content_id,
            "src": src,
            "post": post,
            "include_test": include_test,
        },
        "notes": (
            "A visit = one visitor on one day (visitors are not linked across days). "
            "Engaged time counts only while the page is visible and the reader is active. "
            f"Bounce = under {BOUNCE_MS // 1000} s engaged, or one page with no scroll "
            "past 25%. Visitor statistics exclude the owner, bots and test runs. "
            "Time on page and scroll can lag up to a minute while someone is still reading. "
            "Browser or connection delays can make that longer. "
            "If the final message is lost, recorded time and scroll can be lower. "
            "At most 200 page views per visitor per day are recorded; additional page views are omitted."
        ),
        "totals": {
            "visits": len(every),
            "views": sum(v["pages"] for v in every),
            "engaged_ms": sum(v["engaged"] for v in every),
            "median_visit_engaged_ms": math.trunc(_median([v["engaged"] for v in every])),
            "bounce_rate": pct(sum(1 for v in every if bounced(v)), len(every)),
            "multi_page_rate": pct(sum(1 for v in every if v["pages"] > 1), len(every)),
        },
        "daily": daily,
        "pages": pages,
        "sources": sources,
        "referring_domains": referring,
        "tagged": tagged,
        "earlier": earlier,
    }
