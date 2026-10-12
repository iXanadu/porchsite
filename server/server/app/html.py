"""HTML helpers shared by the public site and the owner's pages. Port of
cloudflare/src/html.ts: esc and markdown come from server/spec/html.py (the
line-by-line port); respond() and nonce() are here, as Starlette responses.
"""

import base64
import secrets
from collections.abc import Mapping

from starlette.responses import Response

from server.spec.html import esc, markdown

__all__ = ["esc", "markdown", "nonce", "respond", "redirect"]


def nonce() -> str:
    return base64.b64encode(secrets.token_bytes(16)).decode()


def respond(
    body: str,
    status: int = 200,
    headers: Mapping[str, str] | None = None,
    csp: str | None = None,
) -> Response:
    """An HTML page with the headers every page carries."""
    h = dict(headers or {})
    h["Content-Type"] = "text/html; charset=utf-8"
    h["X-Content-Type-Options"] = "nosniff"
    h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if csp:
        h["Content-Security-Policy"] = csp
    return Response(body.encode("utf-8"), status_code=status, headers=h)


def redirect(
    location: str, status: int = 302, headers: Mapping[str, str] | None = None
) -> Response:
    """Response.redirect / new Response(null, {status, headers: {Location}})."""
    return Response(None, status_code=status, headers={**(headers or {}), "Location": location})
