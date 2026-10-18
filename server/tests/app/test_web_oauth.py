"""Connecting an assistant over OAuth, end to end: discovery, dynamic client
registration, the owner's consent at /authorize (signed in with a passkey;
here, a session row as in the Cloudflare tests), the token endpoint with
PKCE, /mcp with the token, refresh, and disconnecting on /review/assistants.
The Cloudflare edition gets this from workers-oauth-provider."""

import base64
import hashlib
import re
import secrets
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest

from server.app import oauth

from .web import Mcp, claimed, signed_in, session_hash

REDIRECT = "http://127.0.0.1:33418/callback"


def pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    return verifier, challenge


async def register(http, **extra):
    r = await http.post(
        "/oauth/register",
        json={"client_name": "Desk App", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none", **extra},
    )  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()


def authorize_url(client_id, challenge, state="s1", **extra):
    q = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "scope": "site:draft",
        **extra,
    }
    return f"/authorize?{urlencode(q)}"


async def consent(http, cookies, url, decision="approve", label=""):
    page = await http.get(url, cookies=cookies)
    assert page.status_code == 200, page.text
    handle = re.search(r'name="handle" value="([^"]+)"', page.text).group(1)
    binding = page.cookies.get("__Host-oauth-consent") or re.search(
        r"__Host-oauth-consent=([^;]+)", page.headers["set-cookie"]
    ).group(1)
    form = {"handle": handle, "decision": decision, "label": label}
    return page, await http.post(
        url, data=form, cookies={**cookies, "__Host-oauth-consent": binding}
    )


async def test_discovery(http):
    meta = (await http.get("/.well-known/oauth-authorization-server")).json()
    assert meta["issuer"] == "https://site.example"
    assert meta["authorization_endpoint"] == "https://site.example/authorize"
    assert meta["token_endpoint"] == "https://site.example/oauth/token"
    assert meta["registration_endpoint"] == "https://site.example/oauth/register"
    assert meta["scopes_supported"] == ["site:draft"]
    assert meta["code_challenge_methods_supported"] == ["S256"]
    bare = await http.get("/.well-known/oauth-protected-resource")
    assert bare.status_code == 404 and bare.content == b""
    for path in ("/.well-known/oauth-protected-resource/mcp",):
        r = await http.get(path)
        assert r.json() == {
            "resource": "https://site.example/mcp",
            "authorization_servers": ["https://site.example"],
            "scopes_supported": ["site:draft"],
            "bearer_methods_supported": ["header"],
            "resource_name": "Porchsite site",
        }
        assert r.headers["access-control-allow-origin"] == "*"
    assert (await http.get("/.well-known/oauth-protected-resource/other")).status_code == 404
    assert (await http.options("/oauth/token")).status_code == 204


async def test_register_authorize_token_and_call_mcp(db, http):
    client = await register(http)
    verifier, challenge = pkce()
    url = authorize_url(client["client_id"], challenge)
    # Not claimed yet: no connecting, and it says why (not the setup form).
    early = await http.get(url)
    assert early.status_code == 409 and "Not claimed yet" in early.text
    # The owner signs in first; the request survives the trip.
    await claimed(db)
    gate = await http.get(url)
    assert gate.status_code == 303
    assert gate.headers["location"].startswith("https://site.example/login?next=%2Fauthorize%3F")
    cookies = await signed_in(db)
    page, done = await consent(http, cookies, url, label="My helper")
    assert "Let Desk App work on your site?" in page.text
    assert (
        "This app named itself; the name isn&#39;t verified." in page.text
        or "This app named itself; the name isn't verified." in page.text
    )
    assert "Access goes to <strong>127.0.0.1</strong>" in page.text
    assert "This sends access to an app on a computer." in page.text
    assert page.headers["x-frame-options"] == "DENY"
    assert done.status_code == 302
    back = urlsplit(done.headers["location"])
    assert f"{back.scheme}://{back.netloc}{back.path}" == REDIRECT
    q = parse_qs(back.query)
    assert q["state"] == ["s1"] and q["iss"] == ["https://site.example"]
    code = q["code"][0]

    bad = await http.post("/oauth/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT, "client_id": client["client_id"], "code_verifier": "wrong" * 10})  # fmt: skip
    assert bad.status_code == 400 and bad.json()["error"] == "invalid_grant"
    tok = await http.post("/oauth/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT, "client_id": client["client_id"], "code_verifier": verifier})  # fmt: skip
    assert tok.status_code == 200, tok.text
    t = tok.json()
    assert t["token_type"] == "Bearer" and t["expires_in"] == 3600 and t["scope"] == "site:draft"
    assert t["access_token"].startswith("owner:")
    # A code works once.
    reuse = await http.post("/oauth/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT, "client_id": client["client_id"], "code_verifier": verifier})  # fmt: skip
    assert reuse.status_code == 400

    a = Mcp(http, t["access_token"])
    err, link, _ = await a.call("photo_upload_link")
    assert not err
    err, made, _ = await a.call("item_create", kind="note", data={"text": "Hello.", "date": "2026-10-10"})  # fmt: skip
    err, hist, _ = await a.call("item_history", id=made["id"])
    assert hist["versions"][0]["actor"] == "assistant:My helper"

    fresh = await http.post("/oauth/token", data={"grant_type": "refresh_token", "refresh_token": t["refresh_token"], "client_id": client["client_id"]})  # fmt: skip
    assert fresh.status_code == 200, fresh.text
    a2 = Mcp(http, fresh.json()["access_token"])
    assert not (await a2.call("site_state"))[0]

    # A refresh whose answer was lost can be retried with the same token; the
    # retry's new token replaces the lost one, and the oldest token is gone.
    lost = fresh.json()["refresh_token"]
    retry = await http.post("/oauth/token", data={"grant_type": "refresh_token", "refresh_token": t["refresh_token"], "client_id": client["client_id"]})  # fmt: skip
    assert retry.status_code == 200, retry.text
    newest = retry.json()["refresh_token"]
    assert (await http.post("/oauth/token", data={"grant_type": "refresh_token", "refresh_token": lost, "client_id": client["client_id"]})).status_code == 400  # fmt: skip
    step = await http.post("/oauth/token", data={"grant_type": "refresh_token", "refresh_token": newest, "client_id": client["client_id"]})  # fmt: skip
    assert step.status_code == 200, step.text
    assert (await http.post("/oauth/token", data={"grant_type": "refresh_token", "refresh_token": t["refresh_token"], "client_id": client["client_id"]})).status_code == 400  # fmt: skip

    # The owner sees it on the Assistants page, and can disconnect it.
    page = await http.get("/review/assistants", cookies=cookies)
    assert "<h2>My helper</h2>" in page.text
    grant = re.search(r'name="revoke" value="([^"]+)"', page.text).group(1)
    csrf = re.search(r'name="csrf" value="([^"]+)"', page.text).group(1)
    await http.post("/review/assistants", data={"csrf": "nope", "revoke": grant}, cookies=cookies)
    assert len(await oauth.list_user_grants(db, "owner")) == 1
    gone = await http.post(
        "/review/assistants", data={"csrf": csrf, "revoke": grant}, cookies=cookies
    )
    assert "None yet." in gone.text and "https://site.example/mcp" in gone.text
    r = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers=a2.headers)  # fmt: skip
    assert r.status_code == 401


async def test_the_owner_can_say_no(db, http):
    client = await register(http)
    _, challenge = pkce()
    cookies = await signed_in(db)
    _, denied = await consent(
        http, cookies, authorize_url(client["client_id"], challenge, "s2"), "deny"
    )
    q = parse_qs(urlsplit(denied.headers["location"]).query)
    assert q["error"] == ["access_denied"] and q["state"] == ["s2"]
    assert "Max-Age=0" in denied.headers["set-cookie"]


async def test_bad_requests(db, http):
    cookies = await signed_in(db)
    unknown = await http.get(authorize_url("nobody", "x"), cookies=cookies)
    assert unknown.status_code == 400 and "Can&#39;t connect" in unknown.text
    client = await register(http)
    elsewhere = await http.get(
        authorize_url(client["client_id"], "x").replace("33418", "1"), cookies=cookies
    )
    assert elsewhere.status_code == 400 and "Invalid redirect URI" in elsewhere.text
    plain = await http.get(authorize_url(client["client_id"], "x", code_challenge_method="plain"), cookies=cookies)  # fmt: skip
    assert plain.status_code == 302
    q = parse_qs(urlsplit(plain.headers["location"]).query)
    assert q["error"] == ["invalid_request"] and q["state"] == ["s1"]
    wrong = await http.get(authorize_url(client["client_id"], "x", resource="https://other.example/mcp"), cookies=cookies)  # fmt: skip
    assert parse_qs(urlsplit(wrong.headers["location"]).query)["error"] == ["invalid_target"]
    # A present but incorrect consent cookie is still refused.
    _, challenge = pkce()
    page = await http.get(authorize_url(client["client_id"], challenge), cookies=cookies)
    handle = re.search(r'name="handle" value="([^"]+)"', page.text).group(1)
    http.cookies.clear()
    forged = await http.post(
        "/authorize",
        data={"handle": handle, "decision": "approve"},
        cookies={**cookies, "__Host-oauth-consent": "wrong"},
    )
    assert forged.status_code == 400 and "expired" in forged.text


async def test_the_cli_mints_a_token(test_dsn, db, http):
    root = Path(__file__).resolve().parents[2]
    out = subprocess.run(
        [sys.executable, "-m", "server.app.cli", "token", "--name", "Conformance", "--origin", "https://site.example"],
        cwd=root,
        env={"PORCHSITE_DSN": test_dsn, "PYTHONPATH": str(root), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=True,
    )  # fmt: skip
    token = out.stdout.strip()
    assert token.startswith("owner:")
    err, state, _ = await Mcp(http, token).call("site_state")
    assert not err
    assert any(
        g["metadata"]["client"] == "Conformance" for g in await oauth.list_user_grants(db, "owner")
    )


@pytest.mark.parametrize("decision", ["approve", "deny"])
async def test_missing_consent_cookie_uses_only_owner_session(db, http, decision):
    owner = await signed_in(db)
    client = await register(http)
    _, challenge = pkce()
    url = authorize_url(client["client_id"], challenge)

    async def page():
        response = await http.get(url, cookies=owner)
        assert response.status_code == 200
        return re.search(r'name="handle" value="([^"]+)"', response.text)[1], response.cookies.get(
            "__Host-oauth-consent"
        )

    async def post(handle, cookies):
        http.cookies.clear()
        return await http.post(
            "/authorize", data={"handle": handle, "decision": decision}, cookies=cookies
        )

    handle, _ = await page()
    assert (await post(handle, {})).status_code == 303
    await db.execute(
        "INSERT INTO readers (id,name,created_at) VALUES ('consent-reader','Reader','2026-10-16') ON CONFLICT DO NOTHING"
    )
    await db.execute(
        "INSERT INTO reader_passkeys (id,reader_id,public_key,counter,transports,created_at) VALUES ('reader-key','consent-reader',$1,0,'[]','2026-10-16') ON CONFLICT DO NOTHING",
        b"key",
    )
    await db.execute(
        "INSERT INTO reader_sessions (token_hash,reader_id,credential_id,epoch,created_at,expires_at) VALUES ($1,'consent-reader','reader-key',0,'2026-10-16','2099-01-01') ON CONFLICT DO NOTHING",
        session_hash("reader-consent-token"),
    )
    refused = await post(handle, {"__Host-sk_reader": "reader-consent-token"})
    assert refused.status_code == 303 and refused.headers["Location"] == "/"
    assert (await post(handle, {**owner, "__Host-oauth-consent": "wrong"})).status_code == 400
    done = await post(handle, owner)
    assert done.status_code == 302
    assert ("code" if decision == "approve" else "error") in parse_qs(
        urlsplit(done.headers["Location"]).query
    )
    assert (await post(handle, owner)).status_code == 400
    await page()
    other, _ = await page()
    # The owner is allowed to answer a different valid handle they minted.
    assert (await post(other, owner)).status_code == 302
