"""Claiming a fresh site from a link: /setup?code=... fills the code in, codes
can be issued into the database with an expiry (the CLI's setup-link), a new
one replaces the old, and once the site is claimed every code is dead. Port
of cloudflare/test/setup-links.test.ts, plus the CLI."""

import threading

import pytest

from server.app import cli, owner
from server.app.errors import ApiError

from .conftest import SITE
from .web import claimed


async def unclaimed(db):
    for t in ("passkeys", "sessions", "owner", "setup_codes", "challenges"):
        await db.execute(f"DELETE FROM {t}")


async def test_a_link_fills_in_the_code_and_leaks_nothing(db, http):
    await unclaimed(db)
    page = await http.get("/setup?code=abcde-fghjk")
    assert page.status_code == 200
    assert 'name="code" autocomplete="off" required value="abcde-fghjk"' in page.text
    assert "Your setup code is filled in." in page.text
    assert 'history.replaceState(null, "", location.pathname)' in page.text
    assert page.headers["referrer-policy"] == "no-referrer"
    assert page.headers["cache-control"] == "no-store"
    # Without a code: an empty field, the same headers.
    bare = await http.get("/setup")
    assert "required><label>Your name" in bare.text
    assert "Enter the setup code you were given" in bare.text
    assert bare.headers["referrer-policy"] == "no-referrer"
    assert bare.headers["cache-control"] == "no-store"
    # The code is escaped into the page.
    odd = await http.get('/setup?code="><script>')
    assert 'value="&#34;&#62;&#60;script&#62;"' in odd.text
    # Other pages keep the usual policy.
    assert (await http.get("/login")).status_code == 303


async def test_a_stored_code_from_a_link_works(db, http):
    await unclaimed(db)
    expires_at = await owner.issue_setup_code(db, "stored-code-one", 24)
    assert expires_at > owner.now()
    row = await db.fetchrow("SELECT code_hash FROM setup_codes")
    assert row["code_hash"] != "stored-code-one"  # only its hash is kept
    ok = await http.post("/setup/options", json={"code": " stored-code-one ", "name": "Sam"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["options"]["rp"] == {"name": "Sam", "id": "site.example"}
    # The deploy-time code still works beside it.
    env = await http.post("/setup/options", json={"code": "test-setup-code", "name": "Sam"})
    assert env.status_code == 200


async def test_wrong_and_expired_codes_are_refused(db, http):
    await unclaimed(db)
    await owner.issue_setup_code(db, "stored-code-two", 24)
    wrong = await http.post("/setup/options", json={"code": "nope", "name": "Sam"})
    assert wrong.status_code == 403 and wrong.json()["error"] == "bad_code"
    await db.execute("UPDATE setup_codes SET expires_at = '2020-01-01T00:00:00.000Z'")
    late = await http.post("/setup/options", json={"code": "stored-code-two", "name": "Sam"})
    assert late.status_code == 403 and late.json()["error"] == "code_expired"
    # With no deploy-time code and nothing current stored, nobody can claim.
    with pytest.raises(ApiError) as e:
        await owner.setup_options(db, None, None, "nope", "Sam")
    assert e.value.status == 503 and e.value.code == "no_setup_code"


async def test_a_new_link_replaces_the_old(db, http):
    await unclaimed(db)
    await owner.issue_setup_code(db, "old-link-code", 24)
    # A claim started with the old code...
    started = await http.post("/setup/options", json={"code": "old-link-code", "name": "Sam"})
    assert started.status_code == 200
    await owner.issue_setup_code(db, "new-link-code", 24)
    assert await db.fetchval("SELECT count(*) FROM setup_codes") == 1
    # ...can't finish once a new link is out, and the old code is refused.
    done = await http.post("/setup/verify", json={})
    assert done.status_code == 403 and done.json()["error"] == "code_expired"
    old = await http.post("/setup/options", json={"code": "old-link-code", "name": "Sam"})
    assert old.status_code == 403 and old.json()["error"] == "bad_code"
    new = await http.post("/setup/options", json={"code": "new-link-code", "name": "Sam"})
    assert new.status_code == 200


async def test_once_claimed_every_code_is_refused(db, http):
    await unclaimed(db)
    await owner.issue_setup_code(db, "before-claim", 24)
    await claimed(db)
    for code in ("before-claim", "test-setup-code"):
        r = await http.post("/setup/options", json={"code": code, "name": "Sam"})
        assert r.status_code == 409 and r.json()["error"] == "claimed"
    with pytest.raises(ApiError) as e:
        await owner.issue_setup_code(db, "after-claim", 24)
    assert e.value.code == "claimed"
    page = await http.get("/setup?code=before-claim")
    assert page.status_code == 303
    assert page.headers["location"] == f"{SITE}/login"
    assert page.headers["referrer-policy"] == "no-referrer"
    assert page.headers["cache-control"] == "no-store"


async def test_cli_setup_link_prints_a_link_then_refuses_once_claimed(
    db, http, fresh_tables, monkeypatch, capsys
):
    await unclaimed(db)
    monkeypatch.setenv("PORCHSITE_DSN", fresh_tables)
    monkeypatch.setenv("PORCHSITE_SITE_URL", "https://example.com/")

    def run(*args):
        # The CLI runs its own event loop: off this test's loop, in a thread.
        out = {}
        th = threading.Thread(target=lambda: out.update(code=cli.main(["setup-link", *args])))
        th.start()
        th.join()
        return out["code"]

    assert run("--hours", "2") == 0
    out = capsys.readouterr()
    link = out.out.strip()
    assert link.startswith("https://example.com/setup#code=")
    first = link.split("code=")[1]
    assert "until" in out.err
    expires = await db.fetchval("SELECT expires_at FROM setup_codes")
    assert expires < owner._later(hours=2, minutes=1)

    assert run() == 0
    second = capsys.readouterr().out.strip().split("code=")[1]
    assert second != first
    gone = await http.post("/setup/options", json={"code": first, "name": "Sam"})
    assert gone.json()["error"] == "bad_code"
    ok = await http.post("/setup/options", json={"code": second, "name": "Sam"})
    assert ok.status_code == 200

    await claimed(db)
    assert run() == 1
    assert "already claimed; use a passkey link from the owner's page" in capsys.readouterr().err

async def test_fragment_stays_out_of_server_html_and_clears_before_submit(db,http):
    await unclaimed(db)
    code='fragment-only-credential'
    r=await http.get('/setup#code='+code)
    assert r.status_code==200 and code not in r.text
    assert 'new URLSearchParams(location.hash.slice(1))' in r.text
    assert 'input.value = code.trim().slice(0, 200)' in r.text
    assert r.text.index('history.replaceState')<r.text.index('await fetch(')
    assert 'innerHTML' not in r.text
    assert r.headers['cache-control']=='no-store' and r.headers['referrer-policy']=='no-referrer'
    old=await http.get('/setup?code=legacy-code')
    assert 'value="legacy-code"' in old.text

async def test_next_release_query_cutoff_is_fixed_and_credential_free():
    from server.app.routes import setup_query_refusal
    from starlette.requests import Request
    import json
    for query in ['code=','code=credential-canary','code=%3Cscript%3E','code=a&code=b']:
        req=Request({'type':'http','method':'GET','scheme':'https','server':('site.example',443),'path':'/setup','query_string':query.encode(),'headers':[]})
        r=setup_query_refusal(req,False)
        assert r.status_code==400
        assert json.loads(r.body)=={'error':'code_in_url','message':'This setup link is no longer supported. Ask for a fresh link or enter the code manually.'}
        assert r.headers['cache-control']=='no-store' and r.headers['referrer-policy']=='no-referrer'
        assert 'location' not in r.headers
        assert setup_query_refusal(req) is None
