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
READER_COOKIE = "__Host-sk_reader"
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
    return await _start_session(db, b64url(cred.credential_id), 0)


# --- another passkey: a new device, or the site at a new address ---------------------


async def create_passkey_link(db: Db, req: Request | None = None) -> dict[str, str]:
    """A one-time link to add a passkey; only a signed-in owner can make one."""
    token = b64url(secrets.token_bytes(24))
    expires_at = _later(minutes=LINK_MINUTES)
    async with transaction(db) as c:
        await c.fetchrow("SELECT id FROM auth_state WHERE id = 1 FOR UPDATE")
        if req is not None and not await signed_in(c, req):
            raise ApiError(403, "not_verified", "This sign-in stopped working. Start again.")
        await c.execute(
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
        db,
        json.dumps(
            {
                "challenge": out["challenge"],
                "link": hash_token(token),
                "epoch": await owner_epoch(db),
            }
        ),
        "add",
    )
    return out, set_header


async def add_verify(db: Db, req: Request, response: Any) -> str:
    saved = json.loads(await _take_challenge(db, req, "add"))
    cred = _verify_registration(response, saved["challenge"], req)
    at = now()

    async def guard(c):
        return bool(
            await c.fetchrow(
                "SELECT 1 FROM passkey_links WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2",
                saved["link"],
                at,
            )
        )

    async def writes(c):
        if not await c.fetchrow(
            "UPDATE passkey_links SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $1 RETURNING token_hash",
            at,
            saved["link"],
        ):
            raise ApiError(403, "not_verified", "This link no longer works. Start again.")
        await c.execute(
            "INSERT INTO passkeys (id, public_key, counter, transports, created_at) VALUES ($1,$2,$3,$4,$5)",
            b64url(cred.credential_id),
            cred.credential_public_key,
            cred.sign_count,
            _transports(response),
            at,
        )

    return await _issue_session(
        db,
        "owner",
        b64url(cred.credential_id),
        saved["epoch"],
        new_credential=True,
        guard=guard,
        writes=writes,
    )


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
    return out, await _save_challenge(
        db, json.dumps({"challenge": out["challenge"], "epoch": await owner_epoch(db)}), "login"
    )


async def login_verify(db: Db, req: Request, response: Any) -> str:
    saved = json.loads(await _take_challenge(db, req, "login"))
    cred_id = str(response.get("id", "")) if isinstance(response, dict) else ""
    owner_key = await db.fetchrow(
        "SELECT id,public_key,counter,transports FROM passkeys WHERE id = $1", cred_id
    )
    reader_key = await db.fetchrow(
        "SELECT p.*, r.auth_epoch,r.revoked FROM reader_passkeys p JOIN readers r ON r.id = p.reader_id WHERE p.id = $1",
        cred_id,
    )
    row = owner_key or (reader_key if reader_key and not reader_key["revoked"] else None)
    if not row:
        raise ApiError(403, "unknown_passkey", "That passkey isn't registered for this site.")
    expected = saved["epoch"] if owner_key else reader_key["auth_epoch"]
    rp_id, origin = rp(req)
    try:
        result = verify_authentication_response(
            credential=response,
            expected_challenge=base64url_to_bytes(saved["challenge"]),
            expected_origin=origin,
            expected_rp_id=rp_id,
            credential_public_key=bytes(row["public_key"]),
            credential_current_sign_count=row["counter"],
            require_user_verification=True,
        )
    except Exception:
        raise ApiError(403, "not_verified", "The passkey couldn't be verified.") from None

    async def writes(c):
        table = "passkeys" if owner_key else "reader_passkeys"
        await c.execute(
            f"UPDATE {table} SET counter = $1, last_used_at = $2 WHERE id = $3",
            result.new_sign_count,
            now(),
            cred_id,
        )

    return await _issue_session(
        db,
        "owner" if owner_key else "reader",
        cred_id,
        expected,
        reader_id=reader_key["reader_id"] if reader_key else None,
        writes=writes,
    )


async def owner_epoch(db):
    return (await db.fetchval("SELECT owner_epoch FROM auth_state WHERE id = 1")) or 0


async def _issue_session(
    db, role, credential, expected, *, reader_id=None, new_credential=False, guard=None, writes=None
):
    token = b64url(secrets.token_bytes(32))
    th, at, expires = hash_token(token), now(), _later(days=SESSION_DAYS)
    async with transaction(db) as c:
        # All issuers, recovery and revocation lock this row first.
        epoch = await c.fetchval("SELECT owner_epoch FROM auth_state WHERE id = 1 FOR UPDATE")
        if role == "owner":
            valid = epoch == expected and bool(await c.fetchrow("SELECT 1 FROM owner WHERE id = 1"))
            if not new_credential:
                valid = valid and bool(
                    await c.fetchrow("SELECT 1 FROM passkeys WHERE id = $1", credential)
                )
        else:
            r = await c.fetchrow(
                "SELECT auth_epoch,revoked FROM readers WHERE id = $1 FOR UPDATE", reader_id
            )
            valid = bool(r) and not r["revoked"] and r["auth_epoch"] == expected
            if not new_credential:
                valid = valid and bool(
                    await c.fetchrow(
                        "SELECT 1 FROM reader_passkeys WHERE id = $1 AND reader_id = $2",
                        credential,
                        reader_id,
                    )
                )
        if not valid or (guard is not None and not await guard(c)):
            raise ApiError(403, "not_verified", "This sign-in stopped working. Start again.")
        if writes is not None:
            await writes(c)
        if role == "owner":
            await c.execute(
                "INSERT INTO sessions (token_hash,created_at,expires_at) VALUES ($1,$2,$3)",
                th,
                at,
                expires,
            )
            await c.execute(
                "INSERT INTO owner_session_auth (token_hash,credential_id,epoch) SELECT $1,$2,owner_epoch FROM auth_state WHERE id = 1",
                th,
                credential,
            )
        else:
            await c.execute(
                "INSERT INTO reader_sessions (token_hash,reader_id,credential_id,epoch,created_at,expires_at) SELECT $1,$2,$3,auth_epoch,$4,$5 FROM readers WHERE id = $2",
                th,
                reader_id,
                credential,
                at,
                expires,
            )
    return set_cookie(
        SESSION_COOKIE if role == "owner" else READER_COOKIE, token, SESSION_DAYS * 86400
    )


async def _start_session(db, credential, expected):
    return await _issue_session(db, "owner", credential, expected)


async def signed_in(db: Db, req: Request) -> bool:
    token = cookie(req, SESSION_COOKIE)
    if not token:
        return False
    return bool(
        await db.fetchrow(
            """SELECT 1 FROM sessions s JOIN auth_state a ON a.id = 1
        LEFT JOIN owner_session_auth m ON m.token_hash = s.token_hash
        WHERE s.token_hash = $1 AND s.expires_at > $2 AND
        ((m.token_hash IS NULL AND a.owner_epoch = 0) OR
         (m.epoch = a.owner_epoch AND EXISTS (SELECT 1 FROM passkeys WHERE id = m.credential_id)))""",
            hash_token(token),
            now(),
        )
    )


async def reader_signed_in(db, req):
    token = cookie(req, READER_COOKIE)
    if not token:
        return False
    return bool(
        await db.fetchrow(
            """SELECT 1 FROM reader_sessions s JOIN readers r ON r.id = s.reader_id
        JOIN reader_passkeys p ON p.id = s.credential_id AND p.reader_id = r.id
        WHERE s.token_hash = $1 AND s.expires_at > $2 AND r.revoked = 0 AND r.auth_epoch = s.epoch""",
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


# --- reader invitations -------------------------------------------------------
async def create_reader_invite(db, name, req=None):
    token, id = b64url(secrets.token_bytes(24)), b64url(secrets.token_bytes(18))
    at, expires = now(), _later(days=7)
    async with transaction(db) as c:
        await c.fetchrow("SELECT id FROM auth_state WHERE id = 1 FOR UPDATE")
        if req is not None and not await signed_in(c, req):
            raise ApiError(403, "not_verified", "This sign-in stopped working. Start again.")
        await c.execute(
            "INSERT INTO readers (id,name,created_at) VALUES ($1,$2,$3)", id, name[:80], at
        )
        await c.execute(
            "INSERT INTO reader_invites (token_hash,reader_id,created_at,expires_at) VALUES ($1,$2,$3,$4)",
            hash_token(token),
            id,
            at,
            expires,
        )
    return {"token": token, "id": id, "expires_at": expires}


async def list_readers(db):
    return [
        dict(r)
        for r in await db.fetch(
            "SELECT r.id,r.name,r.revoked,r.created_at,i.expires_at,i.used_at,(SELECT MAX(p.last_used_at) FROM reader_passkeys p WHERE p.reader_id = r.id) AS last_signed_in FROM readers r LEFT JOIN reader_invites i ON i.reader_id = r.id ORDER BY r.created_at"
        )
    ]


async def revoke_reader(db, id):
    async with transaction(db) as c:
        await c.fetchrow("SELECT id FROM auth_state WHERE id = 1 FOR UPDATE")
        await c.execute(
            "UPDATE readers SET revoked = 1,auth_epoch = auth_epoch + 1 WHERE id = $1", id
        )
        await c.execute("DELETE FROM reader_sessions WHERE reader_id = $1", id)
        await c.execute("DELETE FROM reader_invites WHERE reader_id = $1", id)


async def revoke_invite(db, id):
    async with transaction(db) as c:
        await c.fetchrow("SELECT id FROM auth_state WHERE id = 1 FOR UPDATE")
        await c.execute("DELETE FROM reader_invites WHERE reader_id = $1 AND used_at IS NULL", id)


async def invite_options(db, req, token):
    row = await db.fetchrow(
        "SELECT i.token_hash,r.* FROM reader_invites i JOIN readers r ON r.id = i.reader_id WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > $2 AND r.revoked = 0",
        hash_token(token),
        now(),
    )
    if not row:
        raise ApiError(410, "link_used", "This invitation has been used or has expired.")
    options = _options(
        generate_registration_options(
            rp_id=rp(req)[0],
            rp_name="Reader",
            user_name=row["name"] or "reader",
            attestation=AttestationConveyancePreference.NONE,
            authenticator_selection=_SELECTION,
            supported_pub_key_algs=ALGS,
        )
    )
    header = await _save_challenge(
        db,
        json.dumps(
            {
                "challenge": options["challenge"],
                "invite": row["token_hash"],
                "reader": row["id"],
                "epoch": row["auth_epoch"],
            }
        ),
        "invite",
    )
    return options, header


async def invite_verify(db, req, response):
    saved = json.loads(await _take_challenge(db, req, "invite"))
    cred = _verify_registration(response, saved["challenge"], req)
    at = now()

    async def guard(c):
        return bool(
            await c.fetchrow(
                "SELECT 1 FROM reader_invites WHERE token_hash = $1 AND reader_id = $2 AND used_at IS NULL AND expires_at > $3",
                saved["invite"],
                saved["reader"],
                at,
            )
        )

    async def writes(c):
        if not await c.fetchrow(
            "UPDATE reader_invites SET used_at = $1 WHERE token_hash = $2 AND reader_id = $3 AND used_at IS NULL AND expires_at > $1 RETURNING token_hash",
            at,
            saved["invite"],
            saved["reader"],
        ):
            raise ApiError(403, "not_verified", "This invitation no longer works. Start again.")
        await c.execute(
            "INSERT INTO reader_passkeys (id,reader_id,public_key,counter,transports,created_at,last_used_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
            b64url(cred.credential_id),
            saved["reader"],
            cred.credential_public_key,
            cred.sign_count,
            _transports(response),
            at,
        )

    return await _issue_session(
        db,
        "reader",
        b64url(cred.credential_id),
        saved["epoch"],
        reader_id=saved["reader"],
        new_credential=True,
        guard=guard,
        writes=writes,
    )


# --- recovery, issued only by the hosting account ------------------------------
async def issue_recovery_code(db, code, hours=24):
    if not await has_owner(db):
        raise ApiError(409, "unclaimed", "This site has no owner yet.")
    if len(code) < 32:
        raise ApiError(400, "bad_code", "Use a fresh recovery code with at least 24 random bytes.")
    expires = _later(hours=hours)
    async with transaction(db) as c:
        await c.fetchrow("SELECT id FROM auth_state WHERE id = 1 FOR UPDATE")
        await c.execute("DELETE FROM recovery_codes")
        await c.execute(
            "INSERT INTO recovery_codes (code_hash,created_at,expires_at) VALUES ($1,$2,$3)",
            hash_token(code),
            now(),
            expires,
        )
    return expires


async def recover_options(db, req, code):
    if not await has_owner(db):
        raise ApiError(409, "unclaimed", "This site has no owner yet.")
    h = hash_token(code.strip())
    row = await db.fetchrow("SELECT expires_at FROM recovery_codes WHERE code_hash = $1", h)
    if not row:
        raise ApiError(403, "bad_code", "That recovery code isn't valid or has expired.")
    if row["expires_at"] <= now():
        raise ApiError(403, "code_expired", "That recovery code isn't valid or has expired.")
    epoch = await owner_epoch(db)
    o = await db.fetchrow("SELECT name,user_handle FROM owner WHERE id = 1")
    options = _options(
        generate_registration_options(
            rp_id=rp(req)[0],
            rp_name=o["name"] or "My site",
            user_name=o["name"] or "owner",
            user_id=base64url_to_bytes(o["user_handle"]),
            attestation=AttestationConveyancePreference.NONE,
            authenticator_selection=_SELECTION,
            supported_pub_key_algs=ALGS,
        )
    )
    header = await _save_challenge(
        db, json.dumps({"challenge": options["challenge"], "code": h, "epoch": epoch}), "recover"
    )
    return options, header


async def recover_verify(db, req, response):
    saved = json.loads(await _take_challenge(db, req, "recover"))
    cred = _verify_registration(response, saved["challenge"], req)
    at = now()

    async def guard(c):
        return bool(
            await c.fetchrow(
                "SELECT 1 FROM recovery_codes WHERE code_hash = $1 AND expires_at > $2",
                saved["code"],
                at,
            )
        )

    async def writes(c):
        if not await c.fetchrow(
            "DELETE FROM recovery_codes WHERE code_hash = $1 AND expires_at > $2 RETURNING code_hash",
            saved["code"],
            at,
        ):
            raise ApiError(403, "not_verified", "This recovery code no longer works. Start again.")
        await c.execute("DELETE FROM reader_invites WHERE used_at IS NULL")
        await c.execute("UPDATE auth_state SET owner_epoch = owner_epoch + 1 WHERE id = 1")
        for table in (
            "passkeys",
            "passkey_links",
            "sessions",
            "owner_session_auth",
            "reader_sessions",
        ):
            await c.execute(f"DELETE FROM {table}")
        await c.execute("UPDATE readers SET auth_epoch = auth_epoch + 1")
        await c.execute(
            "INSERT INTO passkeys (id,public_key,counter,transports,created_at) VALUES ($1,$2,$3,$4,$5)",
            b64url(cred.credential_id),
            cred.credential_public_key,
            cred.sign_count,
            _transports(response),
            at,
        )

    return await _issue_session(
        db,
        "owner",
        b64url(cred.credential_id),
        saved["epoch"],
        new_credential=True,
        guard=guard,
        writes=writes,
    )
