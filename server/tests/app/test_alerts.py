"""Owner-device Web Push acceptance, paired with the Worker suite."""

import asyncio
import json
import re
import subprocess
from pathlib import Path

import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from server.app import alerts, approvals, content, mcp, owner
from server.app import push_crypto as wire

from . import test_private_site as auth_fixture

browser_factory = auth_fixture.browser_factory
clean = auth_fixture.clean
fixture = auth_fixture.fixture
reader = auth_fixture.reader

ROOT = Path(__file__).resolve().parents[3]
V = json.loads((ROOT / "spec/fixtures/web-push.json").read_text())
SUB = {
    "endpoint": "https://fcm.googleapis.com/push/test",
    "keys": {"p256dh": V["p256dh"], "auth": V["auth"]},
    "label": "Example phone",
}
ORIGIN = "https://site.example"


@pytest_asyncio.fixture(autouse=True)
async def finish_jobs():
    yield
    await alerts.drain()


def decrypt(body):
    salt, pub, ciphertext = body[:16], body[21 : 21 + body[20]], body[21 + body[20] :]
    key = ec.derive_private_key(
        int.from_bytes(wire.unb64(V["receiver"]["d"]), "big"), ec.SECP256R1()
    )
    shared = key.exchange(
        ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), pub)
    )

    def hkdf(material, salt, info, length):
        return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(material)

    ikm = hkdf(
        shared, wire.unb64(V["auth"]), b"WebPush: info\0" + wire.unb64(V["p256dh"]) + pub, 32
    )
    cek = hkdf(ikm, salt, b"Content-Encoding: aes128gcm\0", 16)
    nonce = hkdf(ikm, salt, b"Content-Encoding: nonce\0", 12)
    clear = AESGCM(cek).decrypt(nonce, ciphertext, None)
    assert clear[-1] == 2
    return clear[:-1]


def csrf(b):
    return owner.hash_token("csrf:" + b.http.cookies.get(owner.SESSION_COOKIE))[:32]


async def post(b, path, value, token=True, origin=ORIGIN):
    headers = {"Origin": origin}
    if token:
        headers["X-CSRF"] = csrf(b)
    return await b.at(path, method="POST", json=value, headers=headers)


async def enroll(b):
    response = await post(b, "/review/alerts/subscribe", SUB)
    assert response.status_code == 200, response.text
    return response.json()["id"]


async def pending(db):
    item = await content.create_item(
        db, "assistant:test", "note", {"text": "Example change", "date": "2026-10-16"}, None
    )
    return await approvals.request(db, "assistant:test", [item["id"]], "")


def test_rfc8291_example_vector_and_independent_decryption():
    body = wire.encrypt(
        V["plaintext"].encode(),
        V["p256dh"],
        V["auth"],
        {"privateKey": V["sender"], "salt": wire.unb64(V["salt"])},
    )
    assert wire.b64(body) == V["ciphertext"]
    assert decrypt(body).decode() == V["plaintext"]


def test_cross_edition_encryption_and_bidirectional_decryption(tmp_path):
    bundle = tmp_path / "push.mjs"
    subprocess.run(
        [
            str(ROOT / "cloudflare/node_modules/.bin/esbuild"),
            str(ROOT / "cloudflare/scripts/push-crypto-test.ts"),
            "--bundle",
            "--platform=node",
            "--format=esm",
            "--log-level=error",
            f"--outfile={bundle}",
        ],
        check=True,
        timeout=15,
    )
    message = '{"message":"Example"}'
    encrypted = wire.encrypt(message.encode(), V["p256dh"], V["auth"])
    result = subprocess.run(
        ["node", str(bundle)],
        input=json.dumps({**V, "message": message, "encrypted": wire.b64(encrypted)}),
        text=True,
        capture_output=True,
        timeout=10,
        check=True,
    )
    answer = json.loads(result.stdout)
    assert answer["decrypted"] == message
    assert decrypt(wire.unb64(answer["encrypted"])).decode() == message


@pytest.mark.parametrize(
    "url",
    [
        "http://fcm.googleapis.com/a",
        "https://127.0.0.1/a",
        "https://[::1]/a",
        "https://localhost/a",
        "https://fcm.googleapis.com:444/a",
        "https://@fcm.googleapis.com/a",
        "https://fcm.googleapis.com./a",
        "https://fcm.googleapis.com.evil.example/a",
        "https://notpush.apple.com/a",
        "https://push.apple.com/a",
        "https://notify.windows.com/a",
        "https://%66cm.googleapis.com/a",
        "https://xn--x.push.apple.com/a",
        "https://é.push.apple.com/a",
        "https://fcm.googleapis.com/#",
        "https://fcm.googleapis.com:/a",
    ],
)
def test_endpoint_refusals(url):
    with pytest.raises(ValueError):
        wire.endpoint(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://FCM.GOOGLEAPIS.COM:443/a",
        "https://updates.push.services.mozilla.com/a",
        "https://web.push.apple.com/a",
        "https://a.b.notify.windows.com/a",
    ],
)
def test_endpoint_allowlist(url):
    assert wire.endpoint(url).startswith("https:")


async def test_owner_csrf_subscription_list_and_remove(db, browser_factory):
    b, *_ = await fixture(db, browser_factory)
    assert (await post(b, "/review/alerts/subscribe", SUB, token=False)).status_code == 403
    assert (
        await post(b, "/review/alerts/subscribe", SUB, origin="https://other.example")
    ).status_code == 403
    assert (await browser_factory().post("/review/alerts/subscribe", SUB)).status_code == 404
    id = await enroll(b)
    response = await b.at("/review/alerts")
    assert response.status_code == 200, response.text
    assert (
        "Example phone" in response.text
        and "Added " in response.text
        and "Not used yet" in response.text
    )
    assert SUB["endpoint"] not in response.text and V["auth"] not in response.text
    assert (await post(b, "/review/alerts/remove", {"id": id})).status_code == 200
    assert await alerts.devices(db) == []


async def test_readers_and_assistants_have_no_target_authority(db, browser_factory):
    from server.app import keys

    assistant = await keys.create(db, "Example")
    assert await keys.lookup(db, assistant["token"]) is not None
    await fixture(db, browser_factory)
    r, *_ = await reader(db, browser_factory)
    assert (await r.post("/review/alerts/subscribe", SUB)).status_code == 303
    assert (
        await browser_factory().at(
            "/review/alerts/key", headers={"Authorization": f"Bearer {assistant['token']}"}
        )
    ).status_code == 404


async def test_vapid_first_use_and_credential_cleanup(db, browser_factory):
    b, *_ = await fixture(db, browser_factory)
    a, c = await asyncio.gather(alerts.keys(db), alerts.keys(db))
    assert a["public_key"] == c["public_key"]
    await enroll(b)
    credential = await db.fetchval("SELECT credential_id FROM alert_subscriptions")
    await owner.remove_passkey(db, credential)
    assert await alerts.devices(db) == []
    assert (await b.at("/review/alerts/key")).status_code == 404


async def test_payload_batching_idempotence_and_open_reset(db, browser_factory):
    b, *_ = await fixture(db, browser_factory)
    await enroll(b)
    sent = []

    async def transport(url, headers, body):
        sent.append((url, headers, body))
        return 201

    a, another = await pending(db), await pending(db)
    await asyncio.gather(
        alerts.send_approval(db, a["id"], transport),
        alerts.send_approval(db, a["id"], transport),
        alerts.send_approval(db, another["id"], transport),
    )
    assert len(sent) == 1
    assert json.loads(decrypt(sent[0][2])) == alerts.payload("Hidden handbook", ORIGIN)
    assert sent[0][1]["Authorization"].startswith("vapid t=") and "Topic" not in sent[0][1]
    await alerts.send_approval(db, (await pending(db))["id"], transport)
    assert len(sent) == 1
    await b.at("/review")
    await alerts.send_approval(db, (await pending(db))["id"], transport)
    assert len(sent) == 2
    await db.execute(
        "UPDATE alert_subscriptions SET last_claim_at=last_claim_at-300001,opened_at=0"
    )
    await alerts.send_approval(db, (await pending(db))["id"], transport)
    assert len(sent) == 3


async def test_dead_subscription_redirect_and_send_time_validation(db, browser_factory):
    b, *_ = await fixture(db, browser_factory)
    for status in (404, 410):
        await enroll(b)

        async def dead(url, headers, body):
            return status

        await alerts.send_approval(db, (await pending(db))["id"], dead)
        assert await alerts.devices(db) == []
    sent = []

    async def redirect(url, headers, body):
        sent.append(url)
        return 302

    await enroll(b)
    await alerts.send_approval(db, (await pending(db))["id"], redirect)
    assert len(sent) == 1
    await db.execute(
        "UPDATE alert_subscriptions SET endpoint='https://localhost/x',last_claim_at=0"
    )
    await alerts.send_approval(db, (await pending(db))["id"], redirect)
    assert len(sent) == 1


async def test_private_worker_manifest_and_exact_route_boundaries(db, browser_factory):
    b, *_ = await fixture(db, browser_factory)
    visitor = browser_factory()
    for method in ("GET", "HEAD"):
        for path in ("/sw.js", "/manifest.webmanifest", "/app-icon-192.png", "/app-icon-512.png"):
            response = await visitor.at(path, method=method)
            assert response.status_code == 200, response.text
            assert "Set-Cookie" not in response.headers
            if method == "HEAD":
                assert response.content == b""
    generic = await visitor.at("/manifest.webmanifest")
    assert generic.json()["name"] == "Porchsite" and generic.json()["start_url"] == "/review"
    branded = await b.at("/manifest.webmanifest")
    assert branded.json()["name"] == "Hidden handbook"
    assert branded.headers["Cache-Control"] == "private, no-store, no-transform"
    worker = (await visitor.at("/sw.js")).text
    assert "Hidden handbook" not in worker and "addEventListener('fetch'" not in worker
    for path in ("/sw.js/x", "/manifest.webmanifest/x", "/app-icon-192.png/x"):
        response = await visitor.at(path)
        assert response.status_code == 404
        assert (
            response.text == '<!doctype html><meta name="robots" content="noindex"><title></title>'
        )


async def test_approval_answer_bytes_independent_of_delivery(db, browser_factory, monkeypatch):
    b, *_ = await fixture(db, browser_factory)
    baseline = None
    for mode in ("absent", "present", "failing"):
        if mode != "absent":
            await enroll(b)

        async def transport(url, headers, body):
            if mode == "failing":
                raise OSError("offline")
            return 201

        monkeypatch.setattr(alerts, "deliver_http", transport)
        item = await content.create_item(
            db, "assistant:test", "note", {"text": "Example change", "date": "2026-10-16"}, None
        )
        answer = await mcp._call(
            db,
            "approval_request",
            {"ids": [item["id"]], "note": ""},
            {"client": "test", "origin": ORIGIN},
            "dev",
        )
        await alerts.drain()
        a = answer.structured_content
        text = (
            answer.model_dump_json()
            .replace(a["id"], "REQUEST")
            .replace(item["id"], "ITEM")
            .replace(a["created_at"], "TIME")
        )
        if baseline is None:
            baseline = text
        else:
            assert text == baseline
        assert not any(re.search("alert|delivery", key) for key in a)


async def test_recovery_clears_devices_and_stale_subscribe_cannot_resurrect(
    db, browser_factory, monkeypatch
):
    from .softkey import SoftKey

    b, *_ = await fixture(db, browser_factory)
    await enroll(b)
    code = "q" * 32
    await owner.issue_recovery_code(db, code)
    recovery, new_key = browser_factory(), SoftKey()
    opts = await recovery.options("/recover/options", {"code": code})
    assert (await recovery.post("/recover/verify", new_key.create(opts, ORIGIN))).status_code == 200
    assert await db.fetchval("SELECT count(*) FROM alert_subscriptions") == 0
    assert (await post(b, "/review/alerts/subscribe", SUB)).status_code == 404
    original = alerts.identity
    calls = 0

    async def racing_identity(cx, req):
        nonlocal calls
        who = await original(cx, req)
        calls += 1
        if calls == 1:
            await db.execute("UPDATE auth_state SET owner_epoch=owner_epoch+1 WHERE id=1")
        return who

    monkeypatch.setattr(alerts, "identity", racing_identity)
    request = recovery.http.build_request("POST", "/review/alerts/subscribe")
    from starlette.requests import Request

    req = Request(
        {
            "type": "http",
            "scheme": "https",
            "method": "POST",
            "path": "/review/alerts/subscribe",
            "query_string": b"",
            "server": ("site.example", 443),
            "headers": [(b"cookie", request.headers["cookie"].encode())],
        }
    )
    from server.app.errors import ApiError

    with pytest.raises(ApiError):
        await alerts.subscribe(db, req, SUB, ORIGIN)
    assert await db.fetchval("SELECT count(*) FROM alert_subscriptions") == 0


async def test_import_nudges_after_commit_but_failed_import_does_not(
    db, browser_factory, monkeypatch
):
    b, *_ = await fixture(db, browser_factory)
    await enroll(b)
    sent = []

    async def transport(url, headers, body):
        # A second pool connection can see the committed request while sending.
        assert await db.fetchval("SELECT count(*) FROM approvals WHERE status='pending'") >= 1
        sent.append(body)
        return 201

    monkeypatch.setattr(alerts, "deliver_http", transport)
    document = {
        "porchsite_import": 1,
        "from": "Example",
        "note": "",
        "items": [{"kind": "note", "data": {"text": "Imported change", "date": "2026-10-16"}}],
    }
    response = await b.at(
        "/review/import",
        method="POST",
        data={"csrf": csrf(b)},
        files={"file": ("changes.json", json.dumps(document), "application/json")},
    )
    assert response.status_code == 303
    await alerts.drain()
    assert len(sent) == 1
    document["items"][0]["data"]["date"] = "invalid"
    await b.at(
        "/review/import",
        method="POST",
        data={"csrf": csrf(b)},
        files={"file": ("changes.json", json.dumps(document), "application/json")},
    )
    await alerts.drain()
    assert len(sent) == 1


async def test_real_http_approval_response_bytes_do_not_report_push(
    db, browser_factory, monkeypatch
):
    from server.app import keys

    b, *_ = await fixture(db, browser_factory)
    token = (await keys.create(db, "Example"))["token"]
    baseline = None
    for mode in ("absent", "present", "failing"):
        if mode != "absent":
            await enroll(b)

        async def transport(url, headers, body):
            if mode == "failing":
                raise OSError("offline")
            return 201

        monkeypatch.setattr(alerts, "deliver_http", transport)
        item = await content.create_item(
            db, "assistant:Example", "note", {"text": "Example change", "date": "2026-10-16"}, None
        )
        response = await b.at(
            "/mcp",
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Mcp-Protocol-Version": "2025-06-18",
            },
            json={
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {
                    "name": "approval_request",
                    "arguments": {"ids": [item["id"]], "note": ""},
                },
            },
        )
        assert response.status_code == 200
        await alerts.drain()
        a = response.json()["result"]["structuredContent"]
        normalized = (
            response.content.replace(a["id"].encode(), b"REQUEST")
            .replace(item["id"].encode(), b"ITEM")
            .replace(a["created_at"].encode(), b"TIME")
        )
        if baseline is None:
            baseline = normalized
        else:
            assert normalized == baseline
        assert not any(re.search("alert|delivery", key) for key in a)


async def test_transport_no_redirects_and_network_outside_transaction(
    db, browser_factory, monkeypatch
):
    b, *_ = await fixture(db, browser_factory)
    await enroll(b)
    seen = []
    import httpx

    def handler(request):
        seen.append(request)
        return httpx.Response(302, headers={"Location": "https://other.example/"})

    original = httpx.AsyncClient

    def client(**kwargs):
        assert kwargs["follow_redirects"] is False and kwargs["trust_env"] is False
        return original(**kwargs, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", client)
    await alerts.send_approval(db, (await pending(db))["id"])
    assert len(seen) == 1
    assert "cookie" not in seen[0].headers
    assert seen[0].headers["Authorization"].startswith("vapid t=")
    await db.execute("UPDATE alert_subscriptions SET last_claim_at=0")

    async def removing_transport(url, headers, body):
        credential = await db.fetchval("SELECT credential_id FROM alert_subscriptions")
        await owner.remove_passkey(db, credential)  # Must not deadlock on auth_state.
        return 201

    await asyncio.wait_for(
        alerts.send_approval(db, (await pending(db))["id"], removing_transport), 2
    )
    assert await alerts.devices(db) == []


async def test_vapid_signature_and_malformed_keys(db, browser_factory):
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

    b, *_ = await fixture(db, browser_factory)
    key = await alerts.keys(db)
    authorization = wire.authorization(
        key["private_key"], key["public_key"], SUB["endpoint"], ORIGIN, now=1000
    )
    jwt = authorization.removeprefix("vapid t=").split(", k=")[0]
    header, claims, signature = jwt.split(".")
    assert json.loads(wire.unb64(claims)) == {
        "aud": "https://fcm.googleapis.com",
        "exp": 44200,
        "sub": ORIGIN,
    }
    signature = wire.unb64(signature)
    der = encode_dss_signature(
        int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big")
    )
    wire.public_key(key["public_key"]).verify(
        der, (header + "." + claims).encode(), ec.ECDSA(hashes.SHA256())
    )
    for keys in (
        {"p256dh": "bad", "auth": V["auth"]},
        {"p256dh": V["p256dh"], "auth": "AA"},
        {"p256dh": wire.b64(bytes([4]) * 65), "auth": V["auth"]},
    ):
        assert (await post(b, "/review/alerts/subscribe", {**SUB, "keys": keys})).status_code == 422
    assert await alerts.devices(db) == []


async def test_stalled_push_does_not_hold_approval_response(db, browser_factory, monkeypatch):
    b, *_ = await fixture(db, browser_factory)
    await enroll(b)
    started = asyncio.Event()

    async def stalled(url, headers, body):
        started.set()
        await asyncio.sleep(3600)
        return 201

    monkeypatch.setattr(alerts, "deliver_http", stalled)
    item = await content.create_item(
        db, "assistant:test", "note", {"text": "Example change", "date": "2026-10-16"}, None
    )
    answer = await mcp._call(
        db,
        "approval_request",
        {"ids": [item["id"]], "note": ""},
        {"client": "test", "origin": ORIGIN},
        "dev",
    )
    assert answer.structured_content["status"] == "pending"
    await asyncio.wait_for(started.wait(), 2)
    assert alerts._tasks  # Response exists while the network request is still waiting.
    await asyncio.wait_for(alerts.drain(), 4)
    assert await db.fetchval("SELECT last_used_at FROM alert_subscriptions") is None


def test_service_worker_browser_controls_and_generic_icons_match_the_worker():
    from server.app import alert_assets

    source = (ROOT / "cloudflare/src/alert-assets.ts").read_text()
    for name in ("ALERT_JS", "SW_JS", "ICONS"):
        encoded = re.search(r"^export const " + name + r"=(.*);$", source, re.M)[1]
        assert json.loads(encoded) == getattr(alert_assets, name)


DELTA = json.loads((ROOT / "spec/fixtures/approval-alerts.json").read_text())


@pytest.mark.parametrize("row", DELTA["endpoints"])
def test_canonical_browser_endpoints(row):
    assert wire.endpoint(row["input"]) == row["canonical"]


async def test_canonical_storage_uniqueness_and_fingerprint(db, browser_factory):
    b, *_ = await fixture(db, browser_factory)
    row = DELTA["endpoints"][1]
    for endpoint in (row["input"], row["canonical"]):
        assert (
            await post(b, "/review/alerts/subscribe", {**SUB, "endpoint": endpoint})
        ).status_code == 200
    assert [r["endpoint"] for r in await db.fetch("SELECT endpoint FROM alert_subscriptions")] == [
        row["canonical"]
    ]
    assert (await alerts.devices(db))[0]["fingerprint"] == owner.hash_token(
        "\n".join((row["canonical"], V["p256dh"], V["auth"]))
    )


@pytest.mark.parametrize("cut", DELTA["cuts"])
async def test_utf16_manifest_and_label_cuts(db, browser_factory, cut):
    b, *_ = await fixture(db, browser_factory)
    item = await content.get_item(db, "site")
    site = await content.update_item(
        db, "assistant:test", "site", item["version"], {"title": cut["title"]}
    )
    await auth_fixture.publish(db, [site["id"]])
    manifest = (await b.at("/manifest.webmanifest")).json()
    assert manifest["name"] == cut["title"]
    assert manifest["short_name"] == cut["short_name"]
    assert (
        await post(b, "/review/alerts/subscribe", {**SUB, "label": cut["label"]})
    ).status_code == 200
    assert (await alerts.devices(db))[0]["label"] == cut["saved_label"]


async def test_shared_review_controls_and_current_device_marker(db, browser_factory):
    b, *_ = await fixture(db, browser_factory)
    for on in (False, True):
        if on:
            await enroll(b)
        page = (await b.at("/review")).text
        block = re.search(r'<section id="approval-alerts".*?</section>', page, re.S)[0].replace(
            csrf(b), "CSRF"
        )
        if on:
            device = (await alerts.devices(db))[0]
            block = block.replace(device["id"], "DEVICE").replace(
                device["fingerprint"], "FINGERPRINT"
            )
        assert block == DELTA["controls"]["on" if on else "off"]
    assert "Example phone (this device)" in (await b.at("/review/alerts")).text
    b.http.cookies.delete(alerts.DEVICE_COOKIE)
    assert "Example phone (this device)" not in (await b.at("/review/alerts")).text


async def test_nonowner_review_cannot_reset_batching_even_with_device_marker(db, browser_factory):
    from server.app import keys

    b, *_ = await fixture(db, browser_factory)
    id = await enroll(b)
    r, *_ = await reader(db, browser_factory)
    visitor = browser_factory()
    for client in (r, visitor):
        client.http.cookies.set(alerts.DEVICE_COOKIE, id, domain="site.example", path="/")
    assistant = await keys.create(db, "Example")
    sent = []

    async def transport(*args):
        sent.append(args)
        return 201

    await alerts.send_approval(db, (await pending(db))["id"], transport)
    before = await db.fetchval("SELECT opened_at FROM alert_subscriptions WHERE id=$1", id)
    assert (await visitor.at("/review")).status_code == 404
    assert (
        await visitor.at("/review", headers={"Authorization": f"Bearer {assistant['token']}"})
    ).status_code == 404
    assert (await r.at("/review")).status_code == 303
    assert await db.fetchval("SELECT opened_at FROM alert_subscriptions WHERE id=$1", id) == before
    await alerts.send_approval(db, (await pending(db))["id"], transport)
    assert len(sent) == 1
    assert (await b.at("/review")).status_code == 200
    await alerts.send_approval(db, (await pending(db))["id"], transport)
    assert len(sent) == 2


@pytest.mark.parametrize("elapsed", [299999, 300000, 300001])
async def test_batch_window_edges(db, browser_factory, monkeypatch, elapsed):
    b, *_ = await fixture(db, browser_factory)
    await enroll(b)
    request = await pending(db)
    at = int(alerts.time.time() * 1000)
    await db.execute("UPDATE alert_subscriptions SET last_claim_at=$1,opened_at=0", at)
    monkeypatch.setattr(alerts.time, "time", lambda: (at + elapsed) / 1000)
    sent = []

    async def transport(*args):
        sent.append(args)
        return 201

    await alerts.send_approval(db, request["id"], transport)
    assert len(sent) == (0 if elapsed < 300000 else 1)


async def test_conditional_get_and_head_assets_keep_role_isolation(db, browser_factory):
    b, *_ = await fixture(db, browser_factory)
    visitor = browser_factory()
    for client in (b, visitor):
        for path in ("/sw.js", "/manifest.webmanifest", "/app-icon-192.png", "/app-icon-512.png"):
            baseline = await client.at(path)
            for method in ("GET", "HEAD"):
                response = await client.at(
                    path,
                    method=method,
                    headers={
                        "If-None-Match": '"owner-cached"',
                        "If-Modified-Since": "Wed, 01 Jan 2031 00:00:00 GMT",
                    },
                )
                assert response.status_code == 200
                assert response.headers["Content-Type"] == baseline.headers["Content-Type"]
                assert response.headers["Cache-Control"] == baseline.headers["Cache-Control"]
                assert response.content == (b"" if method == "HEAD" else baseline.content)
                if path == "/manifest.webmanifest" and method == "GET":
                    assert response.json()["name"] == (
                        "Hidden handbook" if client is b else "Porchsite"
                    )


async def test_bounded_retention_does_not_retry_old_requests(db, browser_factory):
    b, *_ = await fixture(db, browser_factory)
    id = await enroll(b)
    request = await pending(db)
    await db.execute(
        "UPDATE approvals SET created_at='2000-01-01T00:00:00.000Z' WHERE id=$1", request["id"]
    )
    await db.execute(
        "INSERT INTO alert_deliveries(request_id,subscription_id,claim,attempted,created_at) SELECT 'old-'||i,$1,'old-'||i,1,0 FROM generate_series(0,500) AS i",
        id,
    )
    await db.execute(
        "INSERT INTO alert_deliveries VALUES('recent',$1,'recent',1,$2)",
        id,
        int(alerts.time.time() * 1000),
    )
    sent = []

    async def transport(*args):
        sent.append(args)
        return 201

    await alerts.send_approval(db, request["id"], transport)
    assert not sent
    assert await db.fetchval("SELECT count(*) FROM alert_deliveries") == 2
    assert await db.fetchval("SELECT 1 FROM alert_deliveries WHERE claim='recent'") == 1
    await alerts.send_approval(db, request["id"], transport)
    assert not sent
    assert await db.fetchval("SELECT count(*) FROM alert_deliveries") == 1
