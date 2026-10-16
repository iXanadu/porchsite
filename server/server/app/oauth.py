"""Assistants connect over OAuth, as the Cloudflare edition does with
workers-oauth-provider (cloudflare/src/index.ts): dynamic client
registration, the authorization code flow with PKCE, the owner's consent at
/authorize (routes.py), a token endpoint, and protected-resource metadata. One
scope, site:draft. An access token is bound to the site's address: the
resource <site>/mcp, where <site> is PORCHSITE_SITE_URL or the address the
request came in on.

The mcp SDK's handlers do registration, the token endpoint and revocation
(mcp.server.auth.handlers), over PgProvider, which keeps clients, grants and
tokens in PostgreSQL. Tokens look like the Cloudflare edition's,
<user>:<grant>:<secret>, and only their hashes are stored. Consent (the
page itself is routes.py) is begin / approve / deny, as the Cloudflare
edition's OAUTH_PROVIDER helpers are.
"""

import hashlib
import json
import re
import secrets
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

from mcp.server.auth.handlers.register import RegistrationHandler
from mcp.server.auth.handlers.revoke import RevocationHandler
from mcp.server.auth.handlers.token import TokenHandler
from mcp.server.auth.middleware.client_auth import ClientAuthenticator
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    RefreshToken,
    TokenError,
)
from mcp.server.auth.settings import ClientRegistrationOptions
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .db import Db, dumps, now, transaction
from .fetch import capped_public_fetch

SCOPES = ["site:draft"]
ACCESS_TTL = 3600
REFRESH_TTL = 30 * 86400
CODE_TTL = 600
CONSENT_TTL = 600
CONSENT_COOKIE = "__Host-oauth-consent"
RESOURCE_NAME = "Porchsite site"
NO_CACHE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _random(n: int = 32) -> str:
    return secrets.token_urlsafe(n)[:n]


def resource_of(origin: str) -> str:
    return f"{origin}/mcp"


def metadata_url(origin: str) -> str:
    return f"{origin}/.well-known/oauth-protected-resource/mcp"


class AuthorizationError(Exception):
    """An authorization request that can't go on: shown to the owner, or sent
    back to the app's redirect address when that address is known to be its own."""

    def __init__(
        self,
        code: str,
        description: str,
        redirect_uri: str | None = None,
        state: str | None = None,
        issuer: str | None = None,
    ):
        super().__init__(description)
        self.code = code
        self.description = description
        self.redirect_uri = redirect_uri
        self.state = state
        self.issuer = issuer


class CimdFetchError(Exception):
    """A client named by a metadata document URL whose document couldn't be had."""


def with_params(url: str, params: dict[str, str]) -> str:
    p = urlsplit(url)
    query = "&".join(x for x in (p.query, urlencode(params)) if x)
    return urlunsplit((p.scheme, p.netloc, p.path, query, p.fragment))


# --- client metadata documents (an https client_id) ------------------------------------

cimd_fetch = capped_public_fetch(5 * 1024)

# Validated documents, kept as long as their Cache-Control allows, at most a
# week (as workers-oauth-provider's CIMD cache): client_id -> (until, info).
CIMD_MAX_TTL = 7 * 86400
CIMD_MAX_KEPT = 200
_cimd_cache: dict[str, tuple[float, OAuthClientInformationFull]] = {}


def _cache_ttl(cache_control: str | None) -> int:
    """Seconds a document may be kept; 0: not at all."""
    if not cache_control or re.search(
        r"(?:^|,)\s*(?:no-cache|no-store|private)\b", cache_control, re.I
    ):
        return 0
    m = re.search(r'(?:^|,)\s*s-maxage\s*=\s*"?(\d+)', cache_control, re.I) or re.search(
        r'(?:^|,)\s*max-age\s*=\s*"?(\d+)', cache_control, re.I
    )
    return min(int(m.group(1)), CIMD_MAX_TTL) if m else 0


async def _client_from_document(client_id: str) -> OAuthClientInformationFull:
    kept = _cimd_cache.get(client_id)
    if kept and kept[0] > time.monotonic():
        return kept[1]
    _cimd_cache.pop(client_id, None)
    try:
        res = await cimd_fetch(client_id, headers={"Accept": "application/json"})
        if not res.is_success or len(res.content) > 5 * 1024:
            raise ValueError("unusable answer")
        doc = json.loads(res.content)
        if not isinstance(doc, dict) or doc.get("client_id") != client_id:
            raise ValueError("client_id doesn't match")
        uris = doc.get("redirect_uris")
        if not isinstance(uris, list) or not uris or not all(isinstance(u, str) for u in uris):
            raise ValueError("no redirect_uris")
        info = OAuthClientInformationFull(
            client_id=client_id,
            client_name=doc.get("client_name") if isinstance(doc.get("client_name"), str) else None,
            redirect_uris=uris,
            token_endpoint_auth_method="none",
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
        )
    except Exception as e:
        raise CimdFetchError(str(e)) from None
    ttl = _cache_ttl(res.headers.get("cache-control"))
    if ttl:
        if len(_cimd_cache) >= CIMD_MAX_KEPT:
            _cimd_cache.pop(next(iter(_cimd_cache)))
        _cimd_cache[client_id] = (time.monotonic() + ttl, info)
    return info


# --- the provider: clients, codes and tokens in PostgreSQL ---------------------------------


class PgProvider:
    """The mcp SDK's OAuthAuthorizationServerProvider, on this site's database."""

    def __init__(self, pool: Callable[[], Db]):
        self._pool = pool

    @property
    def db(self) -> Db:
        return self._pool()

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        if client_id.startswith("https://"):
            return await _client_from_document(client_id)
        row = await self.db.fetchrow(
            "SELECT info FROM oauth_clients WHERE client_id = $1", client_id
        )
        return OAuthClientInformationFull.model_validate_json(row["info"]) if row else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        await self.db.execute(
            "INSERT INTO oauth_clients (client_id, info, created_at) VALUES ($1, $2, $3)",
            client_info.client_id,
            client_info.model_dump_json(exclude_none=True),
            now(),
        )

    async def authorize(
        self, client: OAuthClientInformationFull, params: AuthorizationParams
    ) -> str:
        raise NotImplementedError("/authorize is the owner's consent page (routes.py)")

    async def _token_row(self, token: str, kind: str) -> Any:
        return await self.db.fetchrow(
            "SELECT t.*, g.user_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id"
            " WHERE t.token_hash = $1 AND t.kind = $2",
            _hash(token),
            kind,
        )

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        r = await self._token_row(authorization_code, "code")
        if not r or r["client_id"] != client.client_id:
            return None
        extra = json.loads(r["extra"])
        return AuthorizationCode(
            code=authorization_code,
            scopes=[x for x in r["scope"].split(" ") if x],
            expires_at=r["expires_at"],
            client_id=r["client_id"],
            code_challenge=extra["code_challenge"],
            redirect_uri=extra["redirect_uri"],
            redirect_uri_provided_explicitly=True,
            resource=r["resource"],
            subject=r["user_id"],
        )

    async def _issue(
        self, c: Any, grant_id: str, user_id: str, client_id: str, scopes: list[str], resource: str
    ) -> OAuthToken:
        at = int(time.time())
        access = f"{user_id}:{grant_id}:{_random(32)}"
        refresh = f"{user_id}:{grant_id}:{_random(32)}"
        for token, kind, ttl in ((access, "access", ACCESS_TTL), (refresh, "refresh", REFRESH_TTL)):
            await c.execute(
                "INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, scope, resource, created_at, expires_at)"
                " VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                _hash(token),
                kind,
                grant_id,
                client_id,
                " ".join(scopes),
                resource,
                at,
                at + ttl,
            )
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=ACCESS_TTL,
            scope=" ".join(scopes),
            refresh_token=refresh,
        )

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        async with transaction(self.db) as c:
            # A code works once: of two racing exchanges, only one deletes it.
            r = await c.fetchrow(
                "DELETE FROM oauth_tokens WHERE token_hash = $1 AND kind = 'code' RETURNING grant_id",
                _hash(authorization_code.code),
            )
            if not r:
                raise TokenError("invalid_grant", "authorization code does not exist")
            g = await c.fetchrow(
                "UPDATE oauth_grants SET expires_at = NULL WHERE id = $1 RETURNING user_id",
                r["grant_id"],
            )
            if not g:
                raise TokenError("invalid_grant", "the grant was revoked")
            return await self._issue(
                c,
                r["grant_id"],
                g["user_id"],
                client.client_id,
                authorization_code.scopes,
                authorization_code.resource or "",
            )

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        r = await self._token_row(refresh_token, "refresh")
        if not r or r["client_id"] != client.client_id:
            return None
        return RefreshToken(
            token=refresh_token,
            client_id=r["client_id"],
            scopes=[x for x in r["scope"].split(" ") if x],
            expires_at=r["expires_at"],
            resource=r["resource"],
            subject=r["user_id"],
        )

    async def exchange_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]
    ) -> OAuthToken:
        # The token just used stays good beside the new one, so a refresh whose
        # answer was lost can be retried; any older one goes (as the Cloudflare
        # edition's workers-oauth-provider keeps the previous token).
        used = _hash(refresh_token.token)
        async with transaction(self.db) as c:
            r = await c.fetchrow(
                "SELECT grant_id FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'", used
            )
            # One refresh per connection at a time; then the token must still be there.
            if r:
                await c.execute(
                    "SELECT 1 FROM oauth_grants WHERE id = $1 FOR UPDATE", r["grant_id"]
                )
            if not r or not await c.fetchrow(
                "SELECT 1 FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'", used
            ):
                raise TokenError("invalid_grant", "refresh token does not exist")
            await c.execute(
                "DELETE FROM oauth_tokens WHERE grant_id = $1 AND kind = 'refresh' AND token_hash <> $2",
                r["grant_id"],
                used,
            )
            return await self._issue(
                c,
                r["grant_id"],
                refresh_token.subject or "owner",
                client.client_id,
                scopes,
                refresh_token.resource or "",
            )

    async def load_access_token(self, token: str) -> AccessToken | None:
        r = await self._token_row(token, "access")
        if not r or r["expires_at"] < time.time():
            return None
        return AccessToken(
            token=token,
            client_id=r["client_id"],
            scopes=[x for x in r["scope"].split(" ") if x],
            expires_at=r["expires_at"],
            resource=r["resource"],
            subject=r["user_id"],
        )

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        if isinstance(token, RefreshToken):
            # A refresh token stands for the whole connection.
            gid = await self.db.fetchval(
                "SELECT grant_id FROM oauth_tokens WHERE token_hash = $1", _hash(token.token)
            )
            if gid:
                await self.db.execute("DELETE FROM oauth_grants WHERE id = $1", gid)
            return
        await self.db.execute("DELETE FROM oauth_tokens WHERE token_hash = $1", _hash(token.token))


# --- the authorization request and the owner's consent ---------------------------------------


async def parse_auth_request(
    provider: PgProvider, req: Request, issuer: str, resource: str
) -> dict[str, Any]:
    """Check an authorization request (the query of GET /authorize)."""
    q = req.query_params
    response_type = q.get("response_type") or ""
    client_id = q.get("client_id") or ""
    redirect_uri = q.get("redirect_uri") or ""
    scope = [x for x in (q.get("scope") or "").split(" ") if x]
    state = q.get("state") or ""
    challenge = q.get("code_challenge") or None
    method = q.get("code_challenge_method") or None
    resources = q.getlist("resource")
    if not client_id:
        raise AuthorizationError("invalid_request", "client_id is required")
    client = await provider.get_client(client_id)
    if not client:
        raise AuthorizationError("invalid_request", "Invalid client_id")
    registered = [str(u) for u in client.redirect_uris or []]
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", redirect_uri) or redirect_uri.lower().startswith(
        ("javascript:", "data:", "vbscript:")
    ):
        raise AuthorizationError("invalid_request", "Invalid redirect URI")
    if redirect_uri not in registered and not any(_same_uri(redirect_uri, u) for u in registered):
        raise AuthorizationError("invalid_request", "Invalid redirect URI")

    def back(code: str, description: str) -> AuthorizationError:
        return AuthorizationError(code, description, redirect_uri, state or None, issuer)

    if len(resources) > 1 or (resources and resources[0].rstrip("/") != resource.rstrip("/")):
        raise back(
            "invalid_target", "The requested resource is not served by this authorization server."
        )
    if response_type != "code":
        raise back("unsupported_response_type", "Only the authorization code flow is supported.")
    if challenge:
        if (method or "plain") != "S256":
            raise back("invalid_request", "The plain PKCE method is not allowed. Use S256 instead.")
    elif method:
        raise back(
            "invalid_request",
            "PKCE code_challenge is required when code_challenge_method is provided.",
        )
    else:
        raise back(
            "invalid_request", "Clients must use PKCE (S256) with the authorization code flow."
        )
    return {
        "responseType": response_type,
        "clientId": client_id,
        "redirectUri": redirect_uri,
        "scope": scope,
        "state": state,
        "codeChallenge": challenge,
        "codeChallengeMethod": method,
        "resource": resource,
        "issuer": issuer,
    }


def _same_uri(a: str, b: str) -> bool:
    """The same address, written with or without a trailing slash on a bare host."""

    def norm(u: str) -> str:
        p = urlsplit(u)
        return urlunsplit((p.scheme, p.netloc, p.path or "/", p.query, ""))

    return norm(a) == norm(b)


async def begin_consent(db: Db, ar: dict[str, Any]) -> tuple[str, dict[str, str]]:
    """Hold the request while the owner decides: a handle for the form, and a
    cookie that binds it to this browser."""
    handle = _random(32)
    binding = _random(32)
    at = int(time.time())
    async with transaction(db) as c:
        await c.execute("DELETE FROM oauth_consents WHERE expires_at < $1", at)
        await c.execute(
            "INSERT INTO oauth_consents (handle_hash, binding_hash, request, expires_at) VALUES ($1, $2, $3, $4)",
            _hash(handle),
            _hash(binding),
            dumps(ar),
            at + CONSENT_TTL,
        )
    cookie = (
        f"{CONSENT_COOKIE}={binding}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={CONSENT_TTL}"
    )
    return handle, {"Set-Cookie": cookie}


CLEAR_CONSENT = f"{CONSENT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"


async def _take_consent(db: Db, req: Request, handle: str) -> dict[str, Any]:
    from .owner import cookie, signed_in

    binding = cookie(req, CONSENT_COOKIE)
    # In-app sheets may drop this cookie. A valid owner session still binds
    # the browser: consent GET/POST require it, and SameSite=Lax excludes
    # cross-site POSTs. Owners can answer another valid handle they minted,
    # even if not displayed; missing cookies cannot distinguish those pages.
    owner_bound = binding is None and await signed_in(db, req)
    row = await db.fetchrow(
        "DELETE FROM oauth_consents WHERE handle_hash = $1 AND (binding_hash = $2 OR $4) AND expires_at > $3"
        " RETURNING request",
        _hash(handle),
        _hash(binding or ""),
        int(time.time()),
        owner_bound,
    )
    if not row:
        raise AuthorizationError(
            "invalid_request",
            "This request expired or was already answered. Start again from your app.",
        )
    return json.loads(row["request"])


async def approve_consent(db: Db, req: Request, handle: str) -> dict[str, Any]:
    return await _take_consent(db, req, handle)


async def deny_consent(db: Db, req: Request, handle: str) -> str:
    """The owner said no: back to the app with access_denied."""
    ar = await _take_consent(db, req, handle)
    params = {"error": "access_denied"}
    if ar.get("state"):
        params["state"] = ar["state"]
    if ar.get("issuer"):
        params["iss"] = ar["issuer"]
    return with_params(ar["redirectUri"], params)


async def complete_authorization(
    db: Db,
    ar: dict[str, Any],
    user_id: str,
    metadata: dict[str, Any],
    scope: list[str],
    props: dict[str, Any],
) -> str:
    """Make the grant and its one-time code; returns where to send the browser.
    The app's earlier grants for the same resource are replaced."""
    grant_id = _random(16)
    code = f"{user_id}:{grant_id}:{_random(32)}"
    at = int(time.time())
    async with transaction(db) as c:
        await c.execute(
            "DELETE FROM oauth_grants WHERE user_id = $1 AND client_id = $2 AND resource = $3"
            " AND ($4 = '' OR redirect_uri = $4)",
            user_id,
            ar["clientId"],
            ar["resource"],
            ar["redirectUri"] if ar["clientId"].startswith("https://") else "",
        )
        await c.execute(
            "INSERT INTO oauth_grants (id, client_id, user_id, scope, metadata, props, resource, redirect_uri, created_at, expires_at)"
            " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            grant_id,
            ar["clientId"],
            user_id,
            " ".join(scope),
            dumps(metadata),
            dumps(props),
            ar["resource"],
            ar["redirectUri"],
            at,
            at + CODE_TTL,
        )
        await c.execute(
            "INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, scope, resource, extra, created_at, expires_at)"
            " VALUES ($1, 'code', $2, $3, $4, $5, $6, $7, $8)",
            _hash(code),
            grant_id,
            ar["clientId"],
            " ".join(scope),
            ar["resource"],
            dumps({"code_challenge": ar["codeChallenge"], "redirect_uri": ar["redirectUri"]}),
            at,
            at + CODE_TTL,
        )
    params = {"code": code}
    if ar.get("state"):
        params["state"] = ar["state"]
    if ar.get("issuer"):
        params["iss"] = ar["issuer"]
    return with_params(ar["redirectUri"], params)


async def list_user_grants(db: Db, user_id: str) -> list[dict[str, Any]]:
    rows = await db.fetch(
        "SELECT id, client_id, scope, metadata, created_at FROM oauth_grants"
        " WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at",
        user_id,
        int(time.time()),
    )
    return [
        {
            "id": r["id"],
            "clientId": r["client_id"],
            "scope": [x for x in r["scope"].split(" ") if x],
            "metadata": json.loads(r["metadata"]),
            "createdAt": r["created_at"],
        }
        for r in rows
    ]


async def revoke_grant(db: Db, grant_id: str, user_id: str) -> None:
    await db.execute("DELETE FROM oauth_grants WHERE id = $1 AND user_id = $2", grant_id, user_id)


async def lookup_token(db: Db, token: str, resource: str) -> tuple[dict[str, Any] | None, str]:
    """(props, "") for a live access token bound to this resource, else (None, why)."""
    r = await db.fetchrow(
        "SELECT t.expires_at, t.resource, t.scope, t.client_id, g.props, g.user_id FROM oauth_tokens t"
        " JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = $1 AND t.kind = 'access'",
        _hash(token),
    )
    if not r:
        return None, "Invalid access token"
    if r["resource"] != resource:
        return None, "Access token is not bound to the configured resource"
    if r["expires_at"] < time.time():
        return None, "Access token expired"
    return json.loads(r["props"]), ""


async def mint(db: Db, client: str, origin: str, ttl: int = ACCESS_TTL) -> str:
    """An access token for a named assistant, without the browser dance (the
    admin CLI: tests and the conformance check). It shows on /review/assistants
    like any connected assistant."""
    client_id = f"cli-{_random(12)}"
    grant_id = _random(16)
    token = f"owner:{grant_id}:{_random(32)}"
    at = int(time.time())
    info = OAuthClientInformationFull(
        client_id=client_id,
        client_name=client,
        redirect_uris=["http://localhost/"],
        token_endpoint_auth_method="none",
    )
    async with transaction(db) as c:
        await c.execute(
            "INSERT INTO oauth_clients (client_id, info, created_at) VALUES ($1, $2, $3)",
            client_id,
            info.model_dump_json(exclude_none=True),
            now(),
        )
        await c.execute(
            "INSERT INTO oauth_grants (id, client_id, user_id, scope, metadata, props, resource, created_at)"
            " VALUES ($1, $2, 'owner', $3, $4, $5, $6, $7)",
            grant_id,
            client_id,
            " ".join(SCOPES),
            dumps({"client": client}),
            dumps({"client": client, "clientId": client_id, "origin": origin}),
            resource_of(origin),
            at,
        )
        await c.execute(
            "INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, scope, resource, created_at, expires_at)"
            " VALUES ($1, 'access', $2, $3, $4, $5, $6, $7)",
            _hash(token),
            grant_id,
            client_id,
            " ".join(SCOPES),
            resource_of(origin),
            at,
            at + ttl,
        )
    return token


# --- the protocol endpoints ---------------------------------------------------------------


def _json(v: Any, status: int = 200) -> Response:
    return JSONResponse(v, status_code=status)


def server_metadata(origin: str) -> Response:
    """RFC 8414, as workers-oauth-provider publishes it."""
    return _json(
        {
            "issuer": origin,
            "authorization_endpoint": f"{origin}/authorize",
            "token_endpoint": f"{origin}/oauth/token",
            "protected_resources": [resource_of(origin)],
            "registration_endpoint": f"{origin}/oauth/register",
            "scopes_supported": SCOPES,
            "response_types_supported": ["code"],
            "response_modes_supported": ["query"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": [
                "client_secret_basic",
                "client_secret_post",
                "none",
            ],
            "revocation_endpoint": f"{origin}/oauth/token",
            "code_challenge_methods_supported": ["S256"],
            "authorization_response_iss_parameter_supported": True,
            "client_id_metadata_document_supported": True,
        }
    )


def resource_metadata(origin: str) -> Response:
    """RFC 9728."""
    return _json(
        {
            "resource": resource_of(origin),
            "authorization_servers": [origin],
            "scopes_supported": SCOPES,
            "bearer_methods_supported": ["header"],
            "resource_name": RESOURCE_NAME,
        }
    )


def challenge(origin: str, error: str = "", description: str = "") -> str:
    """WWW-Authenticate for /mcp (RFC 9728 §5.1)."""
    h = f'Bearer realm="OAuth", resource_metadata="{metadata_url(origin)}"'
    if error:
        h += f', error="{error}"'
    h += f', scope="{" ".join(SCOPES)}"'
    if description:
        h += f', error_description="{description}"'
    return h


class Endpoints:
    """POST /oauth/register and /oauth/token (token and revocation requests)."""

    def __init__(self, provider: PgProvider):
        auth = ClientAuthenticator(provider)
        self.register = RegistrationHandler(
            provider, ClientRegistrationOptions(enabled=True, valid_scopes=SCOPES)
        )
        self.token = TokenHandler(provider, auth)
        self.revoke = RevocationHandler(provider, auth)

    async def token_or_revoke(self, req: Request) -> Response:
        form = await req.form()
        if "token" in form and "grant_type" not in form:
            return await self.revoke.handle(req)
        return await self.token.handle(req)
