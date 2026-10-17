"""Binary media validator parity against the Cloudflare helper."""

import json
from pathlib import Path

from starlette.requests import Request
from starlette.responses import Response

from server.app.media_http import conditional_media, media_session

cases = json.loads((Path(__file__).resolve().parents[2] / "spec/media-http-cases.json").read_text())


def request(url, method="GET", headers=None):
    return Request(
        {
            "type": "http",
            "method": method,
            "path": "/",
            "query_string": b"",
            "scheme": "https",
            "server": ("example.com", 443),
            "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        }
    )


out = []
for content_type in ["image/jpeg", "image/png", "image/webp"]:
    url = "https://example.com/media/0123456789abcdef0123456789abcdef." + content_type.split("/")[1]
    body = bytes([0, 255, 128, 10, 13, 254])

    def make():
        return Response(
            body,
            headers={
                "Content-Type": content_type,
                "Cache-Control": "no-cache, no-transform",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'",
            },
        )

    tag = conditional_media(request(url), make(), url).headers["etag"]
    for case in cases:
        for method in ["GET", "HEAD"]:
            headers = (
                {}
                if case["value"] is None
                else {
                    "If-None-Match": case["value"].replace("$tag", tag).replace("$strong", tag[2:])
                }
            )
            response = conditional_media(request(url, method, headers), make(), url)
            out.append(
                {
                    "type": content_type,
                    "case": case["name"],
                    "method": method,
                    "status": response.status_code,
                    "tag": response.headers["etag"],
                    "cache": response.headers["cache-control"],
                    "headers": dict(sorted(response.headers.items())),
                    "body": [] if method == "HEAD" else list(response.body),
                }
            )
sessions = [
    media_session(request("https://example.com", headers={"Cookie": cookie}))
    for cookie in [
        "__Host-sk_owner=x",
        "__Host-sk_reader=x",
        "other=__Host-sk_reader=x",
        "a=1; __Host-sk_reader=x",
    ]
]
print(json.dumps({"responses": out, "sessions": sessions}, separators=(",", ":")))
