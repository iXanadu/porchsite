"""PV-1/OR-1 acceptance, paired with cloudflare/test/private-site.test.ts."""

import asyncio
import json
import re

import httpx
import pytest
import pytest_asyncio
from starlette.requests import Request

from server.app import approvals, content, importer, media, owner, privacy, site
from server.app.errors import ApiError

from .conftest import TABLES
from .softkey import SoftKey

ORIGIN = "https://site.example"
WHO = "assistant:test"


class Browser:
    def __init__(self, http):
        self.http = http

    async def at(self, path, method="GET", **kwargs):
        return await self.http.request(method, path, **kwargs)

    async def post(self, path, body=None):
        return await self.http.post(path, json=body or {})

    async def options(self, path, body=None):
        response = await self.post(path, body)
        assert response.status_code == 200, response.text
        return response.json()["options"]


@pytest_asyncio.fixture(autouse=True)
async def clean(db):
    await db.execute(f"TRUNCATE {TABLES} RESTART IDENTITY")
    await db.execute("UPDATE auth_state SET owner_epoch = 0,private_floor = '' WHERE id = 1")


@pytest_asyncio.fixture
async def browser_factory(http):
    clients = []

    def make():
        client = httpx.AsyncClient(
            transport=http._transport, base_url=ORIGIN, follow_redirects=False
        )
        clients.append(client)
        return Browser(client)

    yield make
    for client in clients:
        await client.aclose()


async def publish(db, ids):
    request = await approvals.request(db, WHO, ids, "")
    await approvals.decide(db, request["id"], {id: {"decision": "approve"} for id in ids}, "")
    return request


async def fixture(db, make, private=True):
    browser, key = make(), SoftKey()
    options = await browser.options("/setup/options", {"code": "test-setup-code", "name": "owner"})
    assert (await browser.post("/setup/verify", key.create(options, ORIGIN))).status_code == 200
    picture = await media.store(
        db, bytes([255, 216, 255, 224]) + bytes([7]) * 60, "image/jpeg", WHO
    )
    item = await content.create_item(
        db,
        WHO,
        "site",
        {
            "title": "Hidden handbook",
            "theme": "personal-homepage",
            "private": private,
            "hero": picture,
            "hero_alt": "Example picture",
            "streams": [{"id": "guide", "title": "Guides", "dated_addresses": False}],
        },
        None,
    )
    entry = await content.create_item(
        db,
        WHO,
        "entry",
        {
            "stream": "guide",
            "title": "Published guide",
            "date": "2026-10-16",
            "body": "Private page body.",
            "tags": ["guide"],
        },
        None,
    )
    await publish(db, [item["id"], entry["id"]])
    return browser, key, item, entry, picture


async def reader(db, make):
    browser, key, invite = make(), SoftKey(), await owner.create_reader_invite(db, "Reader")
    options = await browser.options(f"/invite/{invite['token']}/options")
    response = await browser.post(f"/invite/{invite['token']}/verify", key.create(options, ORIGIN))
    assert response.status_code == 200, response.text
    assert response.json()["reader"] is True
    return browser, key, invite


def blank(response):
    assert response.status_code == 404
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["X-Robots-Tag"] == "noindex"
    assert "Location" not in response.headers
    assert response.text == privacy.BLANK


async def test_visitor_matrix_gates_hits_misses_redirects_before_content(
    db, browser_factory, monkeypatch
):
    _, _, _, _, picture = await fixture(db, browser_factory)
    visitor = browser_factory()
    paths = [
        "/",
        "/guide/published-guide/",
        "/guide/missing/",
        "/sitemap.xml",
        "/guide/feed.xml",
        "/missing/feed.xml",
        "/guide/search.json",
        picture,
        "/media/00000000000000000000000000000000.jpg",
        "/guide/tags/guide/",
        "/review",
        "/review/write",
        "/guide/published-guide",
        "/e/published-guide/",
    ]
    for path in paths:
        blank(await visitor.at(path))
        head = await visitor.at(path, method="HEAD")
        assert head.status_code == 404 and head.content == b""
        assert head.headers["Cache-Control"] == "private, no-store"
    assert (await visitor.at("/robots.txt")).text == "User-agent: *\nDisallow: /\n"

    async def forbidden(*args, **kwargs):
        raise AssertionError("Content lookup before gate")

    monkeypatch.setattr(site, "live_view", forbidden)
    monkeypatch.setattr(media, "published", forbidden)
    blank(await visitor.at(picture))


async def test_reader_role_boundary_and_same_url_cache_isolation(db, browser_factory):
    _, _, _, _, picture = await fixture(db, browser_factory)
    browser, key, invite = await reader(db, browser_factory)
    visitor = browser_factory()
    assert owner.SESSION_COOKIE not in browser.http.cookies
    assert owner.READER_COOKIE in browser.http.cookies
    assert await db.fetchval("SELECT count(*) FROM passkeys") == 1
    assert await db.fetchval("SELECT count(*) FROM reader_passkeys") == 1
    for path in [
        "/",
        "/guide/published-guide/",
        "/sitemap.xml",
        "/guide/feed.xml",
        "/guide/search.json",
        picture,
    ]:
        shown = await browser.at(path)
        assert shown.status_code == 200, path
        assert shown.headers["Cache-Control"] == "private, no-store"
        blank(
            await visitor.at(
                path,
                headers={
                    "If-None-Match": '"cached"',
                    "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT",
                },
            )
        )
    for path in [
        "/review",
        "/review/write",
        "/review/history",
        "/review/stats",
        "/review/assistants",
        "/review/passkeys",
        "/review/import",
        "/review/readers",
        "/review/example/preview",
        "/authorize",
    ]:
        for method in ("GET", "POST"):
            response = await browser.at(path, method=method)
            assert response.status_code == 303, path
            assert response.headers["Location"] == "/"
    login = await browser.options("/login/options")
    assert not login.get("allowCredentials")
    assert (await browser.post("/login/verify", key.get(login, ORIGIN))).json()["reader"] is True

    await owner.revoke_reader(db, invite["id"])
    for path in [
        "/",
        "/guide/published-guide/",
        "/sitemap.xml",
        "/guide/feed.xml",
        "/guide/search.json",
        picture,
    ]:
        blank(
            await browser.at(
                path,
                headers={
                    "If-None-Match": '"cached"',
                    "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT",
                },
            )
        )


async def test_private_fields_exact_version_approval_import_refusal_and_public_restore(
    db, browser_factory
):
    browser, _, item, _, picture = await fixture(db, browser_factory, False)
    visitor = browser_factory()
    draft = await content.update_item(db, WHO, "site", item["version"], {"private": True})
    assert not await privacy.live_private(db)
    assert (await visitor.at("/")).status_code == 200
    enabling = await approvals.request(db, WHO, [draft["id"]], "")
    assert (
        "Passkeys will be required to read this site."
        in (await browser.at("/review/" + enabling["id"])).text
    )
    await approvals.decide(db, enabling["id"], {"site": {"decision": "approve"}}, "")
    assert await privacy.live_private(db)
    blank(await visitor.at("/"))
    for table in ("items", "revisions", "live"):
        query = (
            "SELECT data FROM items WHERE id='site'"
            if table == "items"
            else f"SELECT data FROM {table} WHERE item_id='site'"
        )
        for row in await db.fetch(query):
            assert "private" not in json.loads(row["data"])
    off = await content.update_item(db, WHO, "site", draft["version"], {"private": False})
    request = await approvals.request(db, WHO, [off["id"]], "")
    assert "This makes the site public." in (await browser.at("/review/" + request["id"])).text
    await approvals.decide(db, request["id"], {"site": {"decision": "approve"}}, "")
    assert (await visitor.at("/")).status_code == 200
    assert not await privacy.live_private(db)
    assert "public" in (await visitor.at(picture)).headers["Cache-Control"]
    assert "Allow" in (await visitor.at("/robots.txt")).text
    count = await db.fetchval("SELECT count(*) FROM media")
    try:
        await importer.import_file(
            db,
            json.dumps(
                {
                    "porchsite_import": 1,
                    "items": [{"kind": "site", "data": {"private": False}}],
                    "images": {"bad": "invalid"},
                }
            ),
        )
        raise AssertionError("Import must refuse private")
    except ApiError as error:
        assert error.code == "invalid"
    assert await db.fetchval("SELECT count(*) FROM media") == count


async def test_invites_owner_csrf_single_use_expiry_and_cancel(db, browser_factory):
    browser, _, _, _, _ = await fixture(db, browser_factory)
    page = (await browser.at("/review/readers")).text
    csrf = re.search(r'name="csrf" value="([^"]+)"', page)[1]
    assert (
        await browser.at("/review/readers", method="POST", data={"name": "Reader", "csrf": "wrong"})
    ).status_code == 403
    assert (
        "/invite/"
        in (
            await browser.at(
                "/review/readers", method="POST", data={"name": "Reader", "csrf": csrf}
            )
        ).text
    )
    _, _, invite = await reader(db, browser_factory)
    assert len(await owner.list_readers(db)) == 2
    page = await browser_factory().at(f"/invite/{invite['token']}")
    assert page.headers["Referrer-Policy"] == "no-referrer"
    assert 'history.replaceState(null,"","/login")' in page.text
    assert (await browser_factory().post(f"/invite/{invite['token']}/options")).status_code == 410
    expired = await owner.create_reader_invite(db, "Expired")
    await db.execute(
        "UPDATE reader_invites SET expires_at='2000' WHERE reader_id=$1", expired["id"]
    )
    assert (await browser_factory().post(f"/invite/{expired['token']}/options")).status_code == 410
    cancelled = await owner.create_reader_invite(db, "Cancelled")
    await owner.revoke_invite(db, cancelled["id"])
    assert (
        await browser_factory().post(f"/invite/{cancelled['token']}/options")
    ).status_code == 410


async def test_revoke_and_stale_invite_cannot_mint_and_anonymous_collect_is_empty(
    db, browser_factory
):
    await fixture(db, browser_factory)
    browser, key, invite = await reader(db, browser_factory)
    await owner.revoke_reader(db, invite["id"])
    blank(await browser.at("/"))
    login = await browser.options("/login/options")
    assert (await browser.post("/login/verify", key.get(login, ORIGIN))).status_code == 403
    pending = await owner.create_reader_invite(db, "Pending")
    adding, key = browser_factory(), SoftKey()
    options = await adding.options(f"/invite/{pending['token']}/options")
    await owner.revoke_reader(db, pending["id"])
    assert (
        await adding.post(f"/invite/{pending['token']}/verify", key.create(options, ORIGIN))
    ).status_code == 403
    count = await db.fetchval("SELECT count(*) FROM pageviews")
    assert (
        await browser_factory().at(
            "/collect",
            method="POST",
            headers={"User-Agent": "Mozilla/5.0 (test reader)", "X-Forwarded-For": "192.0.2.20"},
            content=json.dumps({"t": "pv", "id": "private-view-0001", "p": "/", "k": "home"}),
        )
    ).status_code == 204
    assert await db.fetchval("SELECT count(*) FROM pageviews") == count


async def test_atomic_recovery_fences_old_login_and_add_and_keeps_reader_keys(db, browser_factory):
    browser, key, _, _, _ = await fixture(db, browser_factory)
    r, reader_key, _ = await reader(db, browser_factory)
    cookie = browser.http.cookies.get(owner.SESSION_COOKIE)
    stale = browser_factory()
    login = await stale.options("/login/options")
    response = key.get(login, ORIGIN)
    link = await owner.create_passkey_link(db)
    adding, added = browser_factory(), SoftKey()
    add_options = await adding.options(f"/passkey/{link['token']}/options")
    recovery, fresh = browser_factory(), SoftKey()
    await owner.issue_recovery_code(db, "a" * 32)
    options = await recovery.options("/recover/options", {"code": "a" * 32})
    await db.execute("DELETE FROM passkeys")
    assert (
        await recovery.post("/recover/verify", fresh.create(options, ORIGIN))
    ).status_code == 200
    old = browser_factory()
    old.http.cookies.set(owner.SESSION_COOKIE, cookie)
    blank(await old.at("/"))
    blank(await r.at("/"))
    assert (await stale.post("/login/verify", response)).status_code == 403
    assert (
        await adding.post(f"/passkey/{link['token']}/verify", added.create(add_options, ORIGIN))
    ).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM passkeys") == 1
    assert await db.fetchval("SELECT count(*) FROM passkey_links") == 0
    assert await db.fetchval("SELECT count(*) FROM reader_passkeys") == 1
    reader_options = await r.options("/login/options")
    assert (
        await r.post("/login/verify", reader_key.get(reader_options, ORIGIN))
    ).status_code == 200
    new_link = await owner.create_passkey_link(db)
    new_browser, new_key = browser_factory(), SoftKey()
    fresh_options = await new_browser.options(f"/passkey/{new_link['token']}/options")
    assert (
        await new_browser.post(
            f"/passkey/{new_link['token']}/verify", new_key.create(fresh_options, ORIGIN)
        )
    ).status_code == 200
    assert (await browser_factory().post("/recover/options", {"code": "a" * 32})).status_code == 403


async def test_recovery_single_winner_replaced_expired_codes_setup_stays_closed(
    db, browser_factory
):
    assert (await browser_factory().at("/recover")).status_code == 409
    await fixture(db, browser_factory)
    await owner.issue_recovery_code(db, "b" * 32)
    await owner.issue_recovery_code(db, "c" * 32)
    assert (await browser_factory().post("/recover/options", {"code": "b" * 32})).status_code == 403
    a, b, ka, kb = browser_factory(), browser_factory(), SoftKey(), SoftKey()
    oa = await a.options("/recover/options", {"code": "c" * 32})
    ob = await b.options("/recover/options", {"code": "c" * 32})
    results = await asyncio.gather(
        a.post("/recover/verify", ka.create(oa, ORIGIN)),
        b.post("/recover/verify", kb.create(ob, ORIGIN)),
    )
    assert sorted(r.status_code for r in results) == [200, 403]
    assert await db.fetchval("SELECT count(*) FROM passkeys") == 1
    assert await db.fetchval("SELECT count(*) FROM sessions") == 1
    assert (await a.at("/setup")).status_code == 303
    await owner.issue_recovery_code(db, "d" * 32, -1)
    assert (await browser_factory().post("/recover/options", {"code": "d" * 32})).json()[
        "error"
    ] == "code_expired"


async def test_release_floor_contains_no_content_and_readers_stay_out_of_legacy_tables(
    db, browser_factory
):
    await fixture(db, browser_factory)
    await reader(db, browser_factory)
    response = await browser_factory().at("/.well-known/porchsite-release")
    state = response.json()
    assert sorted(state) == ["private_floor", "release"]
    assert state["private_floor"] == "unknown"
    assert response.headers["Cache-Control"] == "private, no-store"
    assert await db.fetchval("SELECT count(*) FROM sessions") == 1
    assert await db.fetchval("SELECT count(*) FROM reader_sessions") == 1
    assert (await site.live_view(db)).site["private"] is True


# Pause after verification and before the atomic issuance transaction (22b).
@pytest.mark.parametrize("kind", ["owner-login", "reader-login", "add", "invite"])
async def test_captured_epoch_fences_controlled_interleavings(
    db, browser_factory, monkeypatch, kind
):
    _, owner_key, _, _, _ = await fixture(db, browser_factory)
    reader_id = ""
    if kind == "owner-login":
        browser = browser_factory()
        response = owner_key.get(await browser.options("/login/options"), ORIGIN)
        complete = owner.login_verify
    elif kind == "reader-login":
        browser, key, invite = await reader(db, browser_factory)
        reader_id = invite["id"]
        response = key.get(await browser.options("/login/options"), ORIGIN)
        complete = owner.login_verify
    elif kind == "add":
        browser, key = browser_factory(), SoftKey()
        link = await owner.create_passkey_link(db)
        response = key.create(await browser.options(f"/passkey/{link['token']}/options"), ORIGIN)
        complete = owner.add_verify
    else:
        browser, key = browser_factory(), SoftKey()
        invite = await owner.create_reader_invite(db, "Pending")
        reader_id = invite["id"]
        response = key.create(await browser.options(f"/invite/{invite['token']}/options"), ORIGIN)
        complete = owner.invite_verify
    original = owner._issue_session
    ready, release = asyncio.Event(), asyncio.Event()

    async def parked(*args, **kwargs):
        ready.set()
        await release.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(owner, "_issue_session", parked)
    cookie = "; ".join(f"{key}={value}" for key, value in browser.http.cookies.items())
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("site.example", 443),
            "path": "/verify",
            "query_string": b"",
            "headers": [(b"cookie", cookie.encode())],
        }
    )
    pending = asyncio.create_task(complete(db, request, response))
    await asyncio.wait_for(ready.wait(), 5)
    monkeypatch.setattr(owner, "_issue_session", original)
    if reader_id:
        await owner.revoke_reader(db, reader_id)
    else:
        recovery, key = browser_factory(), SoftKey()
        await owner.issue_recovery_code(db, "r" * 32)
        options = await recovery.options("/recover/options", {"code": "r" * 32})
        assert (
            await recovery.post("/recover/verify", key.create(options, ORIGIN))
        ).status_code == 200
    sessions = await db.fetchval(
        "SELECT (SELECT count(*) FROM sessions)+(SELECT count(*) FROM reader_sessions)"
    )
    keys = await db.fetchval(
        "SELECT (SELECT count(*) FROM passkeys)+(SELECT count(*) FROM reader_passkeys)"
    )
    release.set()
    with pytest.raises(ApiError) as error:
        await pending
    assert error.value.code == "not_verified"
    assert (
        await db.fetchval(
            "SELECT (SELECT count(*) FROM sessions)+(SELECT count(*) FROM reader_sessions)"
        )
        == sessions
    )
    assert (
        await db.fetchval(
            "SELECT (SELECT count(*) FROM passkeys)+(SELECT count(*) FROM reader_passkeys)"
        )
        == keys
    )


async def test_prior_runtime_blanket_approval_cannot_approve_unseen_private_draft(
    db, browser_factory
):
    _, _, item, _, _ = await fixture(db, browser_factory, False)
    await content.update_item(db, WHO, "site", item["version"], {"private": True})
    await db.execute(
        "UPDATE live SET version=(SELECT version FROM items WHERE id='site'),data=(SELECT data FROM items WHERE id='site') WHERE item_id='site'"
    )
    await db.execute(
        "UPDATE site_fields SET approved=1 WHERE version=(SELECT version FROM live WHERE item_id='site')"
    )
    assert not await privacy.live_private(db)
    assert not (await site.live_view(db)).site["private"]


async def test_hosting_cli_issues_a_hashed_single_use_recovery_link(db, test_dsn, browser_factory):
    from urllib.parse import parse_qs, urlsplit

    from server.app import cli

    await fixture(db, browser_factory)
    link, expires = await cli.recovery_link(test_dsn, ORIGIN, 24)
    parsed = urlsplit(link)
    assert parsed.path == "/recover"
    code = parse_qs(parsed.query)["code"][0]
    assert len(owner.base64url_to_bytes(code)) == 24
    row = await db.fetchrow("SELECT code_hash,expires_at FROM recovery_codes")
    assert row["code_hash"] == owner.hash_token(code)
    assert row["code_hash"] != code
    assert row["expires_at"] == expires
    assert (await browser_factory().post("/recover/options", {"code": code})).status_code == 200


async def test_malformed_cookies_are_blank_and_canonical_redirect_is_private(db, browser_factory):
    await fixture(db, browser_factory)
    visitor = browser_factory()
    blank(await visitor.at("/", headers={"Cookie": "__Host-sk_owner=%; __Host-sk_reader=%"}))
    response = await visitor.at("https://www.site.example/guide/published-guide/")
    assert response.status_code == 301
    assert response.headers["Location"] == ORIGIN + "/guide/published-guide/"
    assert response.headers["Cache-Control"] == "private, no-store"


async def test_every_recovery_mutation_rolls_back_if_insertion_fails(
    db, browser_factory, monkeypatch
):
    browser, _, _, _, _ = await fixture(db, browser_factory)
    await reader(db, browser_factory)
    recovery, key = browser_factory(), SoftKey()
    await owner.issue_recovery_code(db, "z" * 32)
    options = await recovery.options("/recover/options", {"code": "z" * 32})
    cookie = "; ".join(f"{key}={value}" for key, value in recovery.http.cookies.items())
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("site.example", 443),
            "path": "/recover/verify",
            "query_string": b"",
            "headers": [(b"cookie", cookie.encode())],
        }
    )

    def broken(_response):
        raise RuntimeError("fixture insertion failure")

    monkeypatch.setattr(owner, "_transports", broken)
    with pytest.raises(RuntimeError, match="fixture insertion failure"):
        await owner.recover_verify(db, request, key.create(options, ORIGIN))
    assert await owner.owner_epoch(db) == 0
    for table in ("passkeys", "sessions", "reader_passkeys", "reader_sessions", "recovery_codes"):
        assert await db.fetchval(f"SELECT count(*) FROM {table}") == 1
    assert (await browser.at("/")).status_code == 200
    assert (await browser_factory().post("/recover/options", {"code": "z" * 32})).status_code == 200


async def test_reader_cookie_never_authorizes_mcp(db, browser_factory):
    await fixture(db, browser_factory)
    browser, _, _ = await reader(db, browser_factory)
    response = await browser.post(
        "/mcp",
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "site_state", "arguments": {}},
        },
    )
    assert response.status_code == 401
    assert "Hidden handbook" not in response.text


async def test_recovery_invalidates_owner_capability_issuance_already_authorized(
    db, browser_factory
):
    browser, _, _, _, _ = await fixture(db, browser_factory)
    cookie = "; ".join(f"{key}={value}" for key, value in browser.http.cookies.items())
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("site.example", 443),
            "path": "/review/passkeys",
            "query_string": b"",
            "headers": [(b"cookie", cookie.encode())],
        }
    )
    assert await owner.signed_in(db, request)
    recovered, key = browser_factory(), SoftKey()
    await owner.issue_recovery_code(db, "c" * 32)
    options = await recovered.options("/recover/options", {"code": "c" * 32})
    assert (await recovered.post("/recover/verify", key.create(options, ORIGIN))).status_code == 200
    with pytest.raises(ApiError) as error:
        await owner.create_passkey_link(db, request)
    assert error.value.code == "not_verified"
    with pytest.raises(ApiError) as error:
        await owner.create_reader_invite(db, "Reader", request)
    assert error.value.code == "not_verified"
    for table in ("passkey_links", "reader_invites", "readers"):
        assert await db.fetchval(f"SELECT count(*) FROM {table}") == 0
