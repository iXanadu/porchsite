"""Adding a passkey on another device or address: a one-time link from a
signed-in owner. Port of cloudflare/test/passkey-links.test.ts, plus the
other owner pages that need no authenticator."""

import re

import pytest

from server.app import owner
from server.app.errors import ApiError

from .web import claimed, signed_in


async def has_passkey(db):
    await claimed(db)
    await db.execute(
        "INSERT INTO passkeys (id, public_key, counter, created_at) VALUES ('old-key', '\\x00', 0, '2026-10-10')"
        " ON CONFLICT DO NOTHING"
    )


async def test_are_made_only_by_a_signed_in_owner(db, http):
    await has_passkey(db)
    page = await http.get("/review/passkeys")
    assert page.status_code == 303
    assert "/login" in page.headers["location"]


async def test_open_a_page_on_any_address_then_register_for_that_address(db, http):
    await has_passkey(db)
    made = await owner.create_passkey_link(db)
    page = await http.get(f"https://new.example/passkey/{made['token']}")
    assert page.status_code == 200
    assert "Add a passkey here" in page.text
    assert "script-src 'nonce-" in page.headers["content-security-policy"]

    r = await http.post(f"https://new.example/passkey/{made['token']}/options")
    assert r.status_code == 200
    options = r.json()["options"]
    assert options["rp"]["id"] == "new.example"
    assert "old-key" in [c["id"] for c in options["excludeCredentials"]]
    assert options["authenticatorSelection"]["residentKey"] == "required"
    assert options["authenticatorSelection"]["userVerification"] == "required"
    assert "__Host-sk_challenge=" in r.headers["set-cookie"]


async def test_refuse_a_link_that_has_expired_or_been_used(db, http):
    await has_passkey(db)
    made = await owner.create_passkey_link(db)
    await db.execute("UPDATE passkey_links SET used_at = '2026-10-10'")
    assert (await http.get(f"/passkey/{made['token']}")).status_code == 410
    with pytest.raises(ApiError) as e:
        await owner.add_options(db, None, made["token"])
    assert e.value.code == "link_used"
    assert (await http.get(f"/passkey/{'x' * 32}")).status_code == 410
    refused = await http.post(f"/passkey/{made['token']}/options")
    assert refused.status_code == 410
    assert refused.json()["error"] == "link_used"


async def test_the_passkeys_page_makes_a_link(db, http):
    cookies = await signed_in(db)
    page = await http.get("/review/passkeys", cookies=cookies)
    assert "You have 1 passkey for this site." in page.text
    csrf = re.search(r'name="csrf" value="([^"]+)"', page.text).group(1)
    made = await http.post("/review/passkeys", data={"csrf": csrf}, cookies=cookies)
    token = re.search(r"https://site\.example/passkey/([A-Za-z0-9_-]{32})", made.text).group(1)
    assert await owner.passkey_link_open(db, token)


async def test_setup_login_and_logout_pages(db, http):
    # Claimed: setup sends to sign-in, and sign-in carries a safe next.
    assert (await http.get("/setup")).headers["location"] == "https://site.example/login"
    login = await http.get("/login?next=/authorize?client_id=x")
    assert 'location.href = "/authorize?client_id=x"' in login.text
    assert 'location.href = "/review"' in (await http.get("/login?next=https://evil.example")).text
    # A connect request's own address survives sign-in, plain ":" and "/" and all.
    ask = "/authorize?response_type=code&scope=site:draft&redirect_uri=https://app.example/cb&state=a+b~c"
    back = await http.get("/login", params={"next": ask})
    assert f'location.href = "{ask}"' in back.text
    for bad in ("//evil.example", "/reviewer", "/review?</script><b>", '/review?"x', "/review\\x"):
        assert 'location.href = "/review"' in (await http.get("/login", params={"next": bad})).text
    options = await http.post("/login/options")
    assert options.json()["options"]["rpId"] == "site.example"
    assert options.json()["options"]["userVerification"] == "required"
    # A ceremony without its challenge cookie has expired.
    http.cookies.clear()
    late = await http.post("/login/verify", json={"id": "old-key"})
    assert late.status_code == 400 and late.json()["error"] == "expired"
    # Signing out needs the form token.
    cookies = await signed_in(db, "logout-session")
    review = (await http.get("/review", cookies=cookies)).text
    csrf = re.search(r'name="csrf" value="([^"]+)"', review).group(1)
    out = await http.post("/logout", data={"csrf": csrf}, cookies=cookies)
    assert out.status_code == 303 and out.headers["location"] == "/"
    assert "Max-Age=0" in out.headers["set-cookie"]
    assert (await http.get("/review", cookies=cookies)).status_code == 303


async def test_a_fresh_site_is_claimed_with_the_setup_code(db, http):
    await db.execute("DELETE FROM passkeys")
    await db.execute("DELETE FROM sessions")
    await db.execute("DELETE FROM owner")
    assert (await http.get("/review")).headers["location"] == "https://site.example/setup"
    assert (await http.get("/login")).headers["location"] == "https://site.example/setup"
    page = await http.get("/setup")
    assert "Make this site yours" in page.text
    wrong = await http.post("/setup/options", json={"code": "nope", "name": "Sam"})
    assert wrong.status_code == 403 and wrong.json()["error"] == "bad_code"
    ok = await http.post("/setup/options", json={"code": "test-setup-code", "name": "Sam"})
    assert ok.status_code == 200
    options = ok.json()["options"]
    assert options["rp"] == {"name": "Sam", "id": "site.example"}
    assert options["excludeCredentials"] == []
