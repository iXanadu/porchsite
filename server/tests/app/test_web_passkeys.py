"""The owner's passkey, end to end with a software key (SPEC §5): claim the
site, sign in, add a second passkey from a link, and refuse what doesn't
check out. Port of cloudflare/test/passkeys.test.ts."""

from server.app import owner

from .softkey import SoftKey

ORIGIN = "https://site.example"
SESSION = "__Host-sk_owner"


async def options(http, path):
    return (await http.post(path, json={})).json()["options"]


async def test_claims_signs_in_adds_a_second_passkey_and_refuses_a_bad_signature(db, http):
    for t in ("passkeys", "sessions", "owner", "setup_codes", "challenges"):
        await db.execute(f"DELETE FROM {t}")
    key = SoftKey()

    # Claim.
    opts = (await http.post("/setup/options", json={"code": "test-setup-code", "name": "Sam"})).json()["options"]  # fmt: skip
    assert (await http.post("/setup/verify", json=key.create(opts, ORIGIN))).status_code == 200
    assert (await http.get("/review")).status_code == 200
    assert await owner.passkey_count(db) == 1

    # Sign out, then sign in with the same key.
    http.cookies.delete(SESSION)
    assert (await http.get("/review")).status_code == 303
    login = await options(http, "/login/options")
    assert (await http.post("/login/verify", json=key.get(login, ORIGIN))).status_code == 200
    assert (await http.get("/review")).status_code == 200
    assert await db.fetchval("SELECT counter FROM passkeys") == 1

    # A signature that doesn't match is refused, and doesn't sign anyone in.
    http.cookies.delete(SESSION)
    forged = key.get(await options(http, "/login/options"), ORIGIN)
    sig = forged["response"]["signature"]
    forged["response"]["signature"] = sig[:20] + ("B" if sig[20] == "A" else "A") + sig[21:]
    refused = await http.post("/login/verify", json=forged)
    assert refused.status_code == 403
    assert refused.json()["error"] == "not_verified"
    assert (await http.get("/review")).status_code == 303

    # Garbage, or a response made for another address, is refused the same way, never a 500.
    bad = key.get(await options(http, "/login/options"), ORIGIN)
    bad["response"]["clientDataJSON"] = bad["response"]["clientDataJSON"][:-2] + "AA"
    assert (await http.post("/login/verify", json=bad)).status_code == 403
    other = key.get(await options(http, "/login/options"), "https://elsewhere.example")
    assert (await http.post("/login/verify", json=other)).status_code == 403

    # A second passkey from a one-time link.
    await http.post("/login/verify", json=key.get(await options(http, "/login/options"), ORIGIN))
    link = await owner.create_passkey_link(db)
    phone = SoftKey()
    add = await options(http, f"/passkey/{link['token']}/options")
    assert len(add["excludeCredentials"]) == 1
    made = await http.post(f"/passkey/{link['token']}/verify", json=phone.create(add, ORIGIN))
    assert made.status_code == 200
    assert await owner.passkey_count(db) == 2
    http.cookies.delete(SESSION)
    login3 = await options(http, "/login/options")
    assert (await http.post("/login/verify", json=phone.get(login3, ORIGIN))).status_code == 200
