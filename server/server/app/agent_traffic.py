"""Aggregate-only request accounting; identifiers are never written or logged."""

import json
import re
from datetime import UTC, datetime
from importlib.resources import files

from server.spec.jsutil import local

from .html import esc
from .public_http import markdown_path, public_path, session_request

CLASSIFICATION = json.loads(files(__package__).joinpath("agent-traffic.json").read_text())
_AGENTS = {a["token"].lower(): a["kind"] for a in CLASSIFICATION["agents"]}
_TYPES = {
    "text/html; charset=utf-8",
    "text/markdown; charset=utf-8",
    "text/plain; charset=utf-8",
    "application/atom+xml; charset=utf-8",
    "application/xml; charset=utf-8",
}


def agent_kind(ua):
    if not ua or len(ua) > 4096:
        return "other"
    kinds = {
        _AGENTS[token.lower()]
        for token in re.findall(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", ua)
        if token.lower() in _AGENTS
    }
    return next(iter(kinds)) if len(kinds) == 1 else "other"


def countable(req, response):
    if (
        req.method not in ("GET", "HEAD")
        or response.status_code not in (200, 304)
        or session_request(req)
    ):
        return False
    path = req.url.path
    if re.match(
        r"^/(?:review|login|setup|recover|invite|passkey|upload|authorize|oauth|mcp|static|alerts|collect|health|\.well-known)(?:/|$)",
        path,
    ):
        return False
    return (
        bool(public_path(path) or markdown_path(path) or path == "/llms.txt")
        and response.headers.get("content-type", "") in _TYPES
    )


def utc_now():
    return datetime.now(UTC)


async def observe(db, req, response, now=None):
    if not countable(req, response):
        return
    raw = await db.fetchval("SELECT data FROM live WHERE item_id = 'site'")
    timezone = (json.loads(raw).get("timezone") or "UTC") if raw else "UTC"
    day = local(now or utc_now(), timezone).date().isoformat()
    kind = agent_kind(req.headers.get("user-agent", ""))
    await db.execute(
        "INSERT INTO agent_traffic_daily (day, kind, requests) VALUES ($1, $2, 1) ON CONFLICT (day, kind) DO UPDATE SET requests = agent_traffic_daily.requests + 1",
        day,
        kind,
    )


def format_traffic(rows, start, end):
    order = [k["id"] for k in CLASSIFICATION["kinds"]]
    daily = sorted(
        [
            {"day": r["day"], "kind": r["kind"], "requests": int(r["requests"])}
            for r in rows
            if start <= r["day"] <= end
        ],
        key=lambda r: (r["day"], order.index(r["kind"])),
    )
    return {
        "classification_version": CLASSIFICATION["version"],
        "range": {"start": start, "end": end},
        "daily": daily,
        "totals": [
            {
                "kind": k["id"],
                "label": k["label"],
                "requests": sum(r["requests"] for r in daily if r["kind"] == k["id"]),
            }
            for k in CLASSIFICATION["kinds"]
        ],
        "coverage": CLASSIFICATION["coverage"],
        "classification": CLASSIFICATION["classification"],
        "scope": CLASSIFICATION["scope"],
    }


async def traffic_report(db, start, end):
    rows = await db.fetch(
        "SELECT day, kind, requests FROM agent_traffic_daily WHERE day BETWEEN $1 AND $2 ORDER BY day, kind",
        start,
        end,
    )
    return format_traffic(rows, start, end)


def traffic_html(report):
    totals = "".join(
        f'<div class="row"><span>{esc(r["label"])}</span><span>{r["requests"]} requests</span></div>'
        for r in report["totals"]
    )
    if report["daily"]:
        labels = {r["kind"]: r["label"] for r in report["totals"]}
        rows = "".join(
            f"<tr><td>{esc(r['day'])}</td><td>{esc(labels[r['kind']])}</td><td>{r['requests']}</td></tr>"
            for r in report["daily"]
        )
        daily = (
            "<table><thead><tr><th>Day</th><th>Kind</th><th>Requests</th></tr></thead><tbody>"
            + rows
            + "</tbody></table>"
        )
    else:
        daily = '<p class="meta">No observed public requests in this range.</p>'
    return f'<h2 class="sub">Requests by agent kind</h2><p class="meta">{esc(report["coverage"])} {esc(report["classification"])} {esc(report["scope"])}</p><div class="card">{totals}</div>{daily}'
