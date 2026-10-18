"""Fixed OAuth protocol sharing; never used by MCP or owner routes."""
from starlette.responses import Response

PATHS = frozenset((
    "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp", "/oauth/token", "/oauth/register",
))
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Retry-After, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
}


def apply(path: str, response: Response) -> Response:
    if path not in PATHS:
        return response
    vary = [token.strip() for value in response.headers.getlist("vary") for token in value.split(",")
            if token.strip() and token.strip().lower() != "origin"]
    for name in list(response.headers):
        if name.lower().startswith("access-control-"):
            del response.headers[name]
    for name,value in CORS.items():
        response.headers[name] = value
    if vary:
        response.headers["Vary"] = ", ".join(vary)
    elif "vary" in response.headers:
        del response.headers["vary"]
    return response
