"""The owner: one person, signed in with a passkey. A fresh site is claimed
once, with a setup code (the one given at deploy time, or a one-time code
stored hashed with an expiry, e.g. from the server's `setup-link`); after that
every setup code is dead and the setup page is closed for good. Port of cloudflare/src/owner.ts (py_webauthn in place of
SimpleWebAuthn; the options sent to the browser are the same WebAuthn JSON).
"""

import base64
import hashlib
import hmac
import json
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import unquote

from starlette.requests import Request
from webauthn import (
    base64url_to_bytes,
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers.cose import COSEAlgorithmIdentifier
from webauthn.helpers.structs import (
    AttestationConveyancePreference,
    AuthenticatorSelectionCriteria,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from .db import Db, iso, now, transaction
from .errors import ApiError

SESSION_COOKIE = "__Host-sk_owner"
CHALLENGE_COOKIE = "__Host-sk_challenge"
SESSION_DAYS = 30
LINK_MINUTES = 15

# SimpleWebAuthn's defaults: Ed25519, ES256, RS256.
ALGS = [
    COSEAlgorithmIdentifier.EDDSA,
    COSEAlgorithmIdentifier.ECDSA_SHA_256,
    COSEAlgorithmIdentifier.RSASSA_PKCS1_v1_5_SHA_256,
]
_SELECTION = AuthenticatorSelectionCriteria(
    resident_key=ResidentKeyRequirement.REQUIRED,
    user_verification=UserVerificationRequirement.REQUIRED,
)


def _later(**delta: float) -> str:
    return iso(datetime.now(UTC) + timedelta(**delta))


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def hash_token(token: str) -> str:
    return b64url(hashlib.sha256(token.encode("utf-8")).digest())


def cookie(req: Request, name: str) -> str | None:
    m = re.search(rf"(?:^|;\s*){re.escape(name)}=([^;]+)", req.headers.get("cookie") or "")
    return unquote(m.group(1)) if m else None


def set_cookie(name: str, value: str, max_age: int) -> str:
    return f"{name}={value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={max_age}"


def _same(a: str, b: str) -> bool:
    """Constant-time compare, for the setup code."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def rp(req: Request) -> tuple[str, str]:
    """(rpID, origin): the address the request came in on."""
    u = req.url
    return u.hostname or "", f"{u.scheme}://{u.netloc}"


async def has_owner(db: Db) -> bool:
    return bool(await db.fetchrow("SELECT 1 FROM owner WHERE id = 1"))


async def owner_name(db: Db) -> str:
    return (await db.fetchval("SELECT name FROM owner WHERE id = 1")) or ""


async def _save_challenge(db: Db, challenge: str, purpose: str) -> str:
    id = b64url(secrets.token_bytes(18))
    async with transaction(db) as c:
        await c.execute("DELETE FROM challenges WHERE expires_at < $1", now())
        await c.execute(
            "INSERT INTO challenges (id, challenge, purpose, expires_at) VALUES ($1, $2, $3, $4)",
            id,
            challenge,
            purpose,
            _later(minutes=5),
        )
    return set_cookie(CHALLENGE_COOKIE, id, 300)


async def _take_challenge(db: Db, req: Request, purpose: str) -> str:
    id = cookie(req, CHALLENGE_COOKIE)
    if not id:
        raise ApiError(400, "expired", "This sign-in expired. Start again.")
    row = await db.fetchrow(
        "DELETE FROM challenges WHERE id = $1 AND purpose = $2 AND expires_at > $3 RETURNING challenge",
        id,
        purpose,
        now(),
    )
    if not row:
        raise ApiError(400, "expired", "This sign-in expired. Start again.")
    return row["challenge"]


def _options(options: Any) -> dict[str, Any]:
    out = json.loads(options_to_json(options))
    if "pubKeyCredParams" in out:
        # As SimpleWebAuthn sends them.
        out.setdefault("extensions", {"credProps": True})
        out.setdefault("hints", [])
    return out


def _verify_registration(response: Any, challenge: str, req: Request) -> Any:
    rp_id, origin = rp(req)
    try:
        return verify_registration_response(
            credential=response,
            expected_challenge=base64url_to_bytes(challenge),
            expected_origin=origin,
            expected_rp_id=rp_id,
            require_user_verification=True,
            supported_pub_key_algs=ALGS,
        )
    except Exception:
        raise ApiError(
            400, "not_verified", "The passkey couldn't be verified. Try again."
        ) from None


def _transports(response: Any) -> str:
    t = (
        (response or {}).get("response", {}).get("transports")
        if isinstance(response, dict)
        else None
    )
    return json.dumps(t if isinstance(t, list) else [], separators=(",", ":"))


# --- claiming a fresh site -------------------------------------------------------------

SETUP_HOURS = 24
NO_SETUP_CODE = "This site has no setup code yet. Ask whoever set up your site for a setup link."
CODE_EXPIRED = "This setup link has expired. If the site was installed at get.porchsite.dev/install/, run it again with the same name and token for a new one; otherwise ask whoever set it up."


async def issue_setup_code(db: Db, code: str, hours: float = SETUP_HOURS) -> str:
    """Store a one-time setup code (hashed) that works for `hours`; any earlier
    stored code stops working. Returns when it expires. Refused once the site
    is claimed."""
    expires_at = _later(hours=hours)
    async with transaction(db) as c:
        if await c.fetchrow("SELECT 1 FROM owner WHERE id = 1"):
            raise ApiError(409, "claimed", "This site already has an owner.")
        await c.execute("DELETE FROM setup_codes")
        await c.execute(
            "INSERT INTO setup_codes (code_hash, created_at, expires_at) VALUES ($1, $2, $3)",
            hash_token(code),
            now(),
            expires_at,
        )
    return expires_at


async def _still_works(db: Db, setup_code: str | None, via: str) -> None:
    """Refuse if the code a claim started with has stopped working since."""
    if via == "env":
        if not setup_code or len(setup_code) < 8:
            raise ApiError(503, "no_setup_code", NO_SETUP_CODE)
    elif not await db.fetchrow(
        "SELECT 1 FROM setup_codes WHERE code_hash = $1 AND expires_at > $2", via, now()
    ):
        raise ApiError(403, "code_expired", CODE_EXPIRED)


async def _check_setup_code(db: Db, setup_code: str | None, code: str) -> str:
    """Which setup code this is: "env" (the deploy-time one) or the hash of a
    stored one. Refuses a wrong, replaced or expired code."""
    code = code.strip()
    env_ok = bool(setup_code) and len(setup_code or "") >= 8
    if env_ok and _same(code, setup_code or ""):
        return "env"
    h = hash_token(code)
    row = await db.fetchrow("SELECT expires_at FROM setup_codes WHERE code_hash = $1", h)
    if row and row["expires_at"] > now():
        return h
    if row:
        raise ApiError(403, "code_expired", CODE_EXPIRED)
    if not env_ok and not await db.fetchrow(
        "SELECT 1 FROM setup_codes WHERE expires_at > $1", now()
    ):
        raise ApiError(503, "no_setup_code", NO_SETUP_CODE)
    raise ApiError(403, "bad_code", "That setup code isn't right.")


async def setup_options(
    db: Db, req: Request, setup_code: str | None, code: str, name: str
) -> tuple[dict[str, Any], str]:
    if await has_owner(db):
        raise ApiError(409, "claimed", "This site already has an owner. Sign in instead.")
    via = await _check_setup_code(db, setup_code, code)
    rp_id, _ = rp(req)
    handle = secrets.token_bytes(16)
    options = generate_registration_options(
        rp_id=rp_id,
        rp_name=name or "My site",
        user_name=name or "owner",
        user_id=handle,
        attestation=AttestationConveyancePreference.NONE,
        authenticator_selection=_SELECTION,
        supported_pub_key_algs=ALGS,
    )
    out = {**_options(options), "excludeCredentials": []}
    set_header = await _save_challenge(
        db,
        json.dumps(
            {"challenge": out["challenge"], "name": name, "handle": b64url(handle), "via": via}
        ),
        "setup",
    )
    return out, set_header


async def setup_verify(db: Db, req: Request, setup_code: str | None, response: Any) -> str:
    saved = json.loads(await _take_challenge(db, req, "setup"))
    if await has_owner(db):
        raise ApiError(409, "claimed", "This site already has an owner.")
    # The code must still work: a newer setup link, or an expiry, ends it.
    await _still_works(db, setup_code, saved.get("via") or "env")
    cred = _verify_registration(response, saved["challenge"], req)
    at = now()
    # INSERT into owner fails on a second claim (id is fixed at 1), so two
    # racing claims can't both win.
    async with transaction(db) as c:
        await c.execute(
            "INSERT INTO owner (id, name, user_handle, created_at) VALUES (1, $1, $2, $3)",
            saved.get("name") or "",
            saved["handle"],
            at,
        )
        await c.execute(
            "INSERT INTO passkeys (id, public_key, counter, transports, created_at) VALUES ($1, $2, $3, $4, $5)",
            b64url(cred.credential_id),
            cred.credential_public_key,
            cred.sign_count,
            _transports(response),
            at,
        )
        # Claimed: every setup code is done.
        await c.execute("DELETE FROM setup_codes")
    return await _start_session(db)


# --- another passkey: a new device, or the site at a new address ---------------------


async def create_passkey_link(db: Db) -> dict[str, str]:
    """A one-time link to add a passkey; only a signed-in owner can make one."""
    token = b64url(secrets.token_bytes(24))
    expires_at = _later(minutes=LINK_MINUTES)
    await db.execute(
        "INSERT INTO passkey_links (token_hash, created_at, expires_at) VALUES ($1, $2, $3)",
        hash_token(token),
        now(),
        expires_at,
    )
    return {"token": token, "expires_at": expires_at}


async def passkey_link_open(db: Db, token: str) -> bool:
    return bool(
        await db.fetchrow(
            "SELECT 1 FROM passkey_links WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2",
            hash_token(token),
            now(),
        )
    )


LINK_USED = "This link has been used or has expired. Make a new one where you're signed in."


async def add_options(db: Db, req: Request, token: str) -> tuple[dict[str, Any], str]:
    if not await passkey_link_open(db, token):
        raise ApiError(410, "link_used", LINK_USED)
    o = await db.fetchrow("SELECT name, user_handle FROM owner WHERE id = 1")
    if not o:
        raise ApiError(409, "unclaimed", "This site has no owner yet.")
    rp_id, _ = rp(req)
    ids = [r["id"] for r in await db.fetch("SELECT id FROM passkeys")]
    options = generate_registration_options(
        rp_id=rp_id,
        rp_name=o["name"] or "My site",
        user_name=o["name"] or "owner",
        user_id=base64url_to_bytes(o["user_handle"]),
        attestation=AttestationConveyancePreference.NONE,
        authenticator_selection=_SELECTION,
        supported_pub_key_algs=ALGS,
    )
    out = _options(options)
    # The stored ids exactly as kept (SimpleWebAuthn passes them through as written).
    out["excludeCredentials"] = [{"id": i, "type": "public-key"} for i in ids]
    set_header = await _save_challenge(
        db, json.dumps({"challenge": out["challenge"], "link": hash_token(token)}), "add"
    )
    return out, set_header


async def add_verify(db: Db, req: Request, response: Any) -> str:
    saved = json.loads(await _take_challenge(db, req, "add"))
    cred = _verify_registration(response, saved["challenge"], req)
    at = now()
    # Spend the link first: of two racing uses, only one gets a row back.
    spent = await db.fetchrow(
        "UPDATE passkey_links SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL"
        " AND expires_at > $1 RETURNING token_hash",
        at,
        saved["link"],
    )
    if not spent:
        raise ApiError(410, "link_used", LINK_USED)
    await db.execute(
        "INSERT INTO passkeys (id, public_key, counter, transports, created_at) VALUES ($1, $2, $3, $4, $5)",
        b64url(cred.credential_id),
        cred.credential_public_key,
        cred.sign_count,
        _transports(response),
        at,
    )
    return await _start_session(db)


async def passkey_count(db: Db) -> int:
    return await db.fetchval("SELECT COUNT(*) FROM passkeys") or 0


# --- signing in ------------------------------------------------------------------------


async def login_options(db: Db, req: Request) -> tuple[dict[str, Any], str]:
    rp_id, _ = rp(req)
    out = _options(
        generate_authentication_options(
            rp_id=rp_id, user_verification=UserVerificationRequirement.REQUIRED
        )
    )
    return out, await _save_challenge(db, out["challenge"], "login")


async def login_verify(db: Db, req: Request, response: Any) -> str:
    challenge = await _take_challenge(db, req, "login")
    cred_id = str(response.get("id", "")) if isinstance(response, dict) else ""
    row = await db.fetchrow(
        "SELECT id, public_key, counter, transports FROM passkeys WHERE id = $1", cred_id
    )
    if not row:
        raise ApiError(403, "unknown_passkey", "That passkey isn't this site's owner.")
    rp_id, origin = rp(req)
    try:
        result = verify_authentication_response(
            credential=response,
            expected_challenge=base64url_to_bytes(challenge),
            expected_origin=origin,
            expected_rp_id=rp_id,
            credential_public_key=bytes(row["public_key"]),
            credential_current_sign_count=row["counter"],
            require_user_verification=True,
        )
    except Exception:
        raise ApiError(403, "not_verified", "The passkey couldn't be verified.") from None
    await db.execute(
        "UPDATE passkeys SET counter = $1, last_used_at = $2 WHERE id = $3",
        result.new_sign_count,
        now(),
        row["id"],
    )
    return await _start_session(db)


async def _start_session(db: Db) -> str:
    token = b64url(secrets.token_bytes(32))
    await db.execute(
        "INSERT INTO sessions (token_hash, created_at, expires_at) VALUES ($1, $2, $3)",
        hash_token(token),
        now(),
        _later(days=SESSION_DAYS),
    )
    return set_cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400)


async def signed_in(db: Db, req: Request) -> bool:
    token = cookie(req, SESSION_COOKIE)
    if not token:
        return False
    return bool(
        await db.fetchrow(
            "SELECT 1 FROM sessions WHERE token_hash = $1 AND expires_at > $2",
            hash_token(token),
            now(),
        )
    )


async def sign_out(db: Db, req: Request) -> str:
    token = cookie(req, SESSION_COOKIE)
    if token:
        await db.execute("DELETE FROM sessions WHERE token_hash = $1", hash_token(token))
    return set_cookie(SESSION_COOKIE, "", 0)


def csrf(req: Request) -> str:
    """A per-session form token: forms posted from another site can't know it."""
    return hash_token(f"csrf:{cookie(req, SESSION_COOKIE) or ''}")[:32]
