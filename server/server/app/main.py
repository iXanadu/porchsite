"""The server edition's web app: one ASGI application, as the Cloudflare
edition is one Worker (cloudflare/src/index.ts). The OAuth protocol endpoints
and /mcp are here; everything else (the site and the owner's pages) is
routes.py.

    uvicorn server.app.main:app

Settings come from the environment (settings.py). Tokens are bound to the
site's address: PORCHSITE_SITE_URL when set (use it once the site has its
real address), otherwise the address the request came in on.
"""

import contextlib
import json
import logging
import re
from collections.abc import AsyncIterator
from typing import Any

import asyncpg
from ada_url import URL
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import Message, Receive, Scope, Send

from . import alerts, keys, read_keys, mcp, oauth, privacy, routes
from .db import Db, connect
from .settings import Settings

log = logging.getLogger(__name__)

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
}


class App:
    """The ASGI app. `pool` may be given (tests); otherwise one is made from
    settings.dsn at startup."""

    def __init__(self, settings: Settings | None = None, pool: Db | None = None):
        self.settings = settings or Settings.from_env()
        self._pool = pool
        self._own_pool = pool is None
        self.provider = oauth.PgProvider(lambda: self.pool)
        self.endpoints = oauth.Endpoints(self.provider)
        self.server = mcp.create_server(lambda: self.pool, lambda: self.settings.release)
        self.sessions = StreamableHTTPSessionManager(
            app=self.server,
            json_response=True,
            stateless=True,
            # An 8 MiB base64 image batch plus its MCP JSON envelope.
            max_request_body_size=16 * 1024 * 1024,
            security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        )
        self.read_server=mcp.create_server(lambda:self.pool,lambda:self.settings.release,True)
        self.read_sessions=StreamableHTTPSessionManager(app=self.read_server,json_response=True,stateless=True,max_request_body_size=16*1024*1024,security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False))
        self._started = False

    @property
    def pool(self) -> Db:
        if self._pool is None:
            raise RuntimeError("the app hasn't started")
        return self._pool

    @contextlib.asynccontextmanager
    async def started(self) -> AsyncIterator["App"]:
        """The database pool and the MCP session manager, for the app's life."""
        if self._own_pool:
            if not self.settings.dsn:
                raise RuntimeError("PORCHSITE_DSN is not set")
            self._pool = await connect(self.settings.dsn)
        try:
            async with self.sessions.run(), self.read_sessions.run():
                self._started = True
                yield self
        finally:
            self._started = False
            await alerts.drain()
            from . import agent_traffic
            await agent_traffic.drain(self.pool)
            from .public_artifacts import drain
            await drain()
            if self._own_pool and isinstance(self._pool, asyncpg.Pool):
                await self._pool.close()
                self._pool = None

    def origin(self, req: Request) -> str:
        u = req.url
        return self.settings.site_url or f"{u.scheme}://{u.netloc}"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self._lifespan(receive, send)
            return
        if scope["type"] != "http":
            return
        # TLS and HTTP-to-HTTPS redirects belong to the reverse proxy.
        # Its upstream request can be HTTP with the site's public Host.
        req = Request(scope, receive)
        release = self.settings.release.encode("latin-1")
        prepared=False

        async def send_with_release(message: Message) -> None:
            nonlocal prepared
            if not prepared and message['type']=='http.response.start' and 200<=message.get('status',0)<400 and scope.get('method')=='POST' and (scope.get('path','').startswith('/review') or scope.get('path')=='/mcp'):
                prepared=True
                routes.schedule_public(routes.Context(self.pool,self.settings.setup_code,self.provider,self.settings.site_url,self.settings.release,self.settings.public_artifacts))
            # Which release is running, on every answer.
            if message["type"] == "http.response.start":
                headers = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() != b"x-porchsite-release"
                ]
                message = {**message, "headers": [*headers, (b"x-porchsite-release", release)]}
            await send(message)

        # One address per site: a passkey works only where it was made, so
        # www.<domain> sends everyone to <domain>.
        host = req.url.hostname or ""
        if host.startswith("www."):
            u = req.url.replace(hostname=host[4:])
            resp = Response(
                None, status_code=301, headers={"Location": str(u), "Cache-Control": "private, no-store, no-transform" if await privacy.live_private(self.pool) else "max-age=3600"}
            )
            await resp(scope, receive, send_with_release)
            return
        path = req.url.path
        if path == "/health" and req.method in ("GET", "HEAD"):
            resp = await self._health()
            if req.method == "HEAD":
                resp.body = b""
            await resp(scope, receive, send_with_release)
            return
        if path == "/mcp" or path.startswith("/mcp/"):
            await self._mcp(req, scope, receive, send_with_release)
            return
        resp = await self._protocol(req)
        if resp is None:
            cx = routes.Context(
                self.pool,
                self.settings.setup_code,
                self.provider,
                self.settings.site_url,
                self.settings.release,
                self.settings.public_artifacts,
            )
            resp = await routes.handle(req, cx)
        if req.method == "HEAD":
            resp.body = b""
        await resp(scope, receive, send_with_release)

    async def _lifespan(self, receive: Receive, send: Send) -> None:
        stack = contextlib.AsyncExitStack()
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                try:
                    await stack.enter_async_context(self.started())
                except Exception as e:
                    log.exception("startup failed")
                    await send({"type": "lifespan.startup.failed", "message": str(e)})
                    return
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await stack.aclose()
                await send({"type": "lifespan.shutdown.complete"})
                return

    async def _health(self) -> Response:
        """/health, for the container's health check and uptime monitors (a
        server-edition extra): 200 when the database answers, else 503."""
        try:
            await self.pool.fetchval("SELECT 1")
            database = "ok"
        except Exception:
            log.exception("health check: database")
            database = "unreachable"
        ok = database == "ok"
        body = {
            "status": "ok" if ok else "degraded",
            "database": database,
            "release": self.settings.release,
        }
        return _json(body, 200 if ok else 503, {"Cache-Control": "no-store"})

    async def _protocol(self, req: Request) -> Response | None:
        """The OAuth protocol endpoints (workers-oauth-provider's, in the Cloudflare edition)."""
        path = req.url.path
        m = req.method
        is_meta = path == "/.well-known/oauth-authorization-server"
        is_resource = path == "/.well-known/oauth-protected-resource" or path.startswith(
            "/.well-known/oauth-protected-resource/"
        )
        is_token = path == "/oauth/token"
        is_register = path == "/oauth/register"
        if not (is_meta or is_resource or is_token or is_register):
            return None
        if m == "OPTIONS":
            return _cors(Response(None, status_code=204, headers={"Content-Length": "0"}))
        origin = self.origin(req)
        if is_meta or is_resource:
            if m not in ("GET", "HEAD"):
                return _cors(
                    Response(None, status_code=405, headers={"Allow": "GET, HEAD, OPTIONS"})
                )
            if is_meta:
                return _cors(oauth.server_metadata(origin))
            if path not in (
                "/.well-known/oauth-protected-resource",
                "/.well-known/oauth-protected-resource/mcp",
            ):
                return _cors(Response(None, status_code=404))
            return _cors(oauth.resource_metadata(origin))
        if m != "POST":
            return _cors(Response(None, status_code=405, headers={"Allow": "POST, OPTIONS"}))
        if is_register:
            return _cors(await self.endpoints.register.handle(req))
        return _cors(await self.endpoints.token_or_revoke(req))

    async def _mcp(self, req: Request, scope: Scope, receive: Receive, send: Send) -> None:
        """/mcp, for an assistant holding an access token bound to this site."""
        origin = self.origin(req)
        if not _mcp_origin_allowed(req, origin):
            await _cors(Response("Invalid Origin header", status_code=403))(
                scope, receive, send
            )
            return
        if req.method == "OPTIONS":
            await _cors(Response(None, status_code=204, headers={"Content-Length": "0"}))(
                scope, receive, send
            )
            return
        header = req.headers.get("authorization") or ""
        bearer = re.match(r"^Bearer[\t ]+([^\s,]+)\Z", header, re.I)
        no_cache = {"Cache-Control": "no-store"}
        if not bearer:
            resp = Response(
                None,
                status_code=401,
                headers={**no_cache, "WWW-Authenticate": oauth.challenge(origin)},
            )
            await _cors(resp)(scope, receive, send)
            return
        if bearer.group(1).startswith((keys.PREFIX,read_keys.PREFIX)):
            # An assistant key (keys.py) instead of an OAuth token: the same tools.
            who = await (read_keys.lookup(self.pool,bearer.group(1)) if bearer.group(1).startswith(read_keys.PREFIX) else keys.lookup(self.pool, bearer.group(1)))
            props, why = (
                ({**who, "origin": origin}, "")
                if who
                else (None, "This key doesn't work: it was revoked, it expired, or it's mistyped.")
            )
        else:
            props, why = await oauth.lookup_token(
                self.pool, bearer.group(1), oauth.resource_of(origin)
            )
        if props is None:
            body = {"error": "invalid_token", "error_description": why}
            resp = _json(
                body,
                401,
                {**no_cache, "WWW-Authenticate": oauth.challenge(origin, "invalid_token")},
            )
            await _cors(resp)(scope, receive, send)
            return
        inner: dict[str, Any] = {**scope, "porchsite.props": props}
        async def protected_send(message):
            if read_keys.restricted(props) and message['type']=='http.response.start':
                message={**message,'headers':[(k,v) for k,v in message['headers'] if k.lower()!=b'cache-control']+[(b'cache-control',b'private, no-store, no-transform')]}
            await send(message)
        await (self.read_sessions if read_keys.restricted(props) else self.sessions).handle_request(inner, receive, protected_send)


def _mcp_origin_allowed(req: Request, site: str) -> bool:
    values = req.headers.getlist("origin")
    if not values:
        return True
    value = values[0].strip(" \t")
    if (
        len(values) != 1
        or value.endswith(":")
        or not re.fullmatch(r"https?://[^/?#@\s\\,%]+", value, re.I)
    ):
        return False
    try:
        actual, expected = URL(value), URL(site)
        if expected.hostname.startswith("www."):
            expected.hostname = expected.hostname[4:]
        return actual.origin == expected.origin
    except ValueError:
        return False


def _cors(resp: Response) -> Response:
    for k, v in CORS.items():
        resp.headers[k] = v
    return resp


def _json(v: Any, status: int, headers: dict[str, str]) -> Response:
    return Response(
        json.dumps(v).encode(),
        status_code=status,
        headers={"Content-Type": "application/json", **headers},
    )


def create_app(settings: Settings | None = None, pool: Db | None = None) -> App:
    return App(settings, pool)


app = create_app()
