"""Owner-only Web Push settings; a nudge never changes approval responses."""

import asyncio
import json
import secrets
import time
from urllib.parse import urlsplit

import httpx

from . import owner
from . import push_crypto as wire
from .db import dumps, transaction
from .errors import ApiError

DEVICE_COOKIE = "__Host-sk_alertdevice"
_tasks = set()


def cookie(req):
    return owner.cookie(req, DEVICE_COOKIE) or ""


async def identity(db, req):
    token = owner.hash_token(owner.cookie(req, owner.SESSION_COOKIE) or "")
    row = await db.fetchrow(
        """SELECT m.credential_id,m.epoch FROM owner_session_auth m
        JOIN auth_state a ON a.id=1 AND a.owner_epoch=m.epoch JOIN passkeys p ON p.id=m.credential_id
        JOIN sessions s ON s.token_hash=m.token_hash WHERE m.token_hash=$1 AND s.expires_at>$2""",
        token,
        owner.now(),
    )
    if not row:
        raise ApiError(
            403, "owner_required", "Sign out and sign in again before turning alerts on."
        )
    return dict(row)


async def keys(db):
    row = await db.fetchrow("SELECT private_key,public_key FROM alert_keys WHERE id=1")
    if not row:
        pair = wire.key_pair()
        await db.execute(
            "INSERT INTO alert_keys(id,private_key,public_key) VALUES(1,$1,$2) ON CONFLICT DO NOTHING",
            pair["private_key"],
            pair["public_key"],
        )
        row = await db.fetchrow("SELECT private_key,public_key FROM alert_keys WHERE id=1")
    return dict(row)


async def subscribe(db, req, value, origin):
    who = await identity(db, req)
    try:
        endpoint = wire.endpoint(value.get("endpoint"))
        wire.public_key(value["keys"]["p256dh"])
        if len(wire.unb64(value["keys"]["auth"])) != 16:
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ApiError(
            422,
            "invalid_subscription",
            "This browser's alert subscription is not supported. Try again.",
        ) from None
    site = urlsplit(origin)
    if site.scheme != "https" or not site.hostname or site.username or site.password:
        raise ApiError(422, "invalid_origin", "Alerts need this site's HTTPS address.")
    origin = f"https://{site.hostname}" + (
        f":{site.port}" if site.port and site.port != 443 else ""
    )
    id, at = secrets.token_hex(16), int(time.time() * 1000)
    label = value.get("label", "This device")
    label = label.strip()[:80] if isinstance(label, str) else "This device"
    async with transaction(db) as c:
        epoch = await c.fetchval("SELECT owner_epoch FROM auth_state WHERE id=1 FOR UPDATE")
        current = await identity(c, req)
        if epoch != who["epoch"] or current != who:
            raise ApiError(403, "owner_required", "Sign in again before turning alerts on.")
        await c.execute(
            "DELETE FROM alert_subscriptions WHERE endpoint=$1 OR id=$2", endpoint, cookie(req)
        )
        await c.execute(
            "INSERT INTO alert_subscriptions(id,endpoint,credential_id,epoch,p256dh,auth,origin,label,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            id,
            endpoint,
            who["credential_id"],
            who["epoch"],
            value["keys"]["p256dh"],
            value["keys"]["auth"],
            origin.rstrip("/"),
            label or "This device",
            at,
        )
    return id


async def remove(db, req, id):
    async with transaction(db) as c:
        await c.fetchval("SELECT owner_epoch FROM auth_state WHERE id=1 FOR UPDATE")
        await identity(c, req)
        await c.execute("DELETE FROM alert_subscriptions WHERE id=$1", id)


async def devices(db):
    rows = await db.fetch(
        "SELECT s.* FROM alert_subscriptions s JOIN passkeys p ON p.id=s.credential_id JOIN auth_state a ON a.id=1 AND a.owner_epoch=s.epoch ORDER BY s.created_at,s.id"
    )
    return [
        {
            "id": row["id"],
            "label": row["label"],
            "created_at": row["created_at"],
            "last_used_at": row["last_used_at"],
            "fingerprint": owner.hash_token(
                "\n".join((row["endpoint"], row["p256dh"], row["auth"]))
            ),
        }
        for row in rows
    ]


async def opened(db, req):
    await db.execute(
        "UPDATE alert_subscriptions SET opened_at=GREATEST($1,last_claim_at+1) WHERE id=$2",
        int(time.time() * 1000),
        cookie(req),
    )


def payload(title, origin):
    return {
        "message": "Your site has a change waiting for you",
        "title": title or "Porchsite",
        "url": origin.rstrip("/") + "/review",
    }


async def deliver_http(url, headers, body):
    async with httpx.AsyncClient(timeout=3, follow_redirects=False, trust_env=False) as client:
        async with client.stream("POST", url, headers=headers, content=body) as response:
            return response.status_code


async def send_approval(db, request_id, transport=None):
    transport = transport or deliver_http
    rows = await db.fetch("SELECT id FROM alert_subscriptions")
    if not rows:
        return
    key = await keys(db)
    live = await db.fetchval("SELECT data FROM live WHERE item_id='site'")
    title = str(json.loads(live).get("title") or "Porchsite") if live else "Porchsite"
    for row in rows:
        try:
            at, claim = int(time.time() * 1000), secrets.token_hex(16)
            async with transaction(db) as c:
                await c.fetchval("SELECT owner_epoch FROM auth_state WHERE id=1 FOR UPDATE")
                sub = await c.fetchrow(
                    "SELECT s.* FROM alert_subscriptions s JOIN auth_state a ON a.id=1 AND a.owner_epoch=s.epoch JOIN passkeys p ON p.id=s.credential_id WHERE s.id=$1 FOR UPDATE OF s",
                    row["id"],
                )
                if not sub or not await c.fetchrow(
                    "SELECT 1 FROM approvals WHERE id=$1 AND status='pending'", request_id
                ):
                    continue
                attempt = not (
                    sub["last_claim_at"] > 0
                    and at - sub["last_claim_at"] < 300000
                    and sub["opened_at"] <= sub["last_claim_at"]
                )
                saved = await c.fetchrow(
                    "INSERT INTO alert_deliveries(request_id,subscription_id,claim,attempted,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING claim",
                    request_id,
                    sub["id"],
                    claim,
                    int(attempt),
                    at,
                )
                if not saved or not attempt:
                    continue
                await c.execute(
                    "UPDATE alert_subscriptions SET last_claim_at=GREATEST($1,opened_at) WHERE id=$2",
                    at,
                    sub["id"],
                )
            url = wire.endpoint(sub["endpoint"])
            body = wire.encrypt(
                dumps(payload(title, sub["origin"])).encode(), sub["p256dh"], sub["auth"]
            )
            headers = {
                "Authorization": wire.authorization(
                    key["private_key"], key["public_key"], url, sub["origin"]
                ),
                "Content-Encoding": "aes128gcm",
                "Content-Type": "application/octet-stream",
                "TTL": "300",
            }
            async with asyncio.timeout(3):
                status = await transport(url, headers, body)
            if status in (404, 410):
                await db.execute("DELETE FROM alert_subscriptions WHERE id=$1", sub["id"])
            elif 200 <= status < 300:
                await db.execute(
                    "UPDATE alert_subscriptions SET last_used_at=$1 WHERE id=$2",
                    int(time.time() * 1000),
                    sub["id"],
                )
        except Exception:
            pass  # Optional nudge; never log endpoint, keys or content.


def schedule(db, request_id):
    async def safe():
        try:
            await send_approval(db, request_id)
        except Exception:
            pass

    coroutine = safe()
    try:
        task = asyncio.create_task(coroutine)
    except Exception:
        coroutine.close()
        return
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def drain():
    if _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)
