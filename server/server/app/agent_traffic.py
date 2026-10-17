"""Aggregate-only request accounting; identifiers are never written or logged."""

import json
import asyncio
import time
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
        req.method != "GET"
        or response.status_code != 200
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


_BUFFERS={}
_TASKS=set()

def buffer(db):
    key=getattr(db,'db',db)
    if key not in _BUFFERS:
        _BUFFERS[key]=dict(pending={},last=float('-inf'),flight=None)
    return _BUFFERS[key]

def reset(db):
    _BUFFERS.pop(getattr(db,'db',db),None)

def add(state,key,count):
    state['pending'][key]=state['pending'].get(key,0)+count
    while len(state['pending'])>8:
        del state['pending'][next(iter(state['pending']))]

async def flush(db,now=None):
    now=time.time()*1000 if now is None else now
    state=buffer(db)
    if state['flight'] is not None:
        await state['flight']
        return
    if not state['pending'] or now-state['last']<60000:
        return
    rows=list(state['pending'].items())
    state['pending'].clear()
    state['last']=now
    async def work():
        try:
            args=[]
            for (day,kind),count in rows:
                args.extend([day,kind,count])
            values=','.join('('+','.join('$'+str(i+j) for j in range(3))+')' for i in range(1,len(args)+1,3))
            await db.execute('INSERT INTO agent_traffic_daily(day,kind,requests) VALUES '+values+' ON CONFLICT(day,kind) DO UPDATE SET requests=agent_traffic_daily.requests+excluded.requests',*args)
        except Exception:
            for key,count in rows:
                add(state,key,count)
    state['flight']=asyncio.create_task(work())
    try:
        await state['flight']
    finally:
        state['flight']=None

async def observe(db,req,response,now=None,timezone=None):
    if not countable(req,response):
        return
    if timezone is None:
        raw=await db.fetchval("SELECT data FROM live WHERE item_id = 'site'")
        timezone=(json.loads(raw).get('timezone') or 'UTC') if raw else 'UTC'
    now=now or utc_now()
    day=local(now,timezone).date().isoformat()
    add(buffer(db),(day,agent_kind(req.headers.get('user-agent',''))),1)
    await flush(db,now.timestamp()*1000)

def schedule(work):
    async def guarded():
        try:
            await work
        except Exception:
            pass  # Accounting must never change delivery.
    task=asyncio.create_task(guarded())
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


async def settle(db):
    if _TASKS:
        await asyncio.gather(*list(_TASKS),return_exceptions=True)
    state=_BUFFERS.get(getattr(db,'db',db))
    if state and state['flight'] is not None:
        await state['flight']

async def drain(db):
    await settle(db)
    reset(db)


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
    await settle(db)
    state=buffer(db)
    if state['flight'] is not None:
        await state['flight']
    rows = await db.fetch(
        "SELECT day, kind, requests FROM agent_traffic_daily WHERE day BETWEEN $1 AND $2 ORDER BY day, kind",
        start,
        end,
    )
    merged={(r["day"],r["kind"]):int(r["requests"]) for r in rows}
    for key,count in state["pending"].items():
        merged[key]=merged.get(key,0)+count
    return format_traffic([dict(day=day,kind=kind,requests=count) for (day,kind),count in merged.items()],start,end)


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
