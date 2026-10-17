"""Conditional media responses; access and publication must be checked first."""

import hashlib

from starlette.responses import Response

from .public_http import matches_tag
from .public_http import session_request as media_session

__all__ = ["conditional_media", "media_session"]


def conditional_media(req, response, canonical_url):
    headers = dict(response.headers)
    prefix = (
        canonical_url
        + "\0"
        + headers.get("content-type", "")
        + "\0"
        + headers.get("content-signal", "")
        + "\0"
    ).encode("utf-8")
    tag = 'W/"sha256-' + hashlib.sha256(prefix + response.body).hexdigest() + '"'
    headers.update({"etag": tag, "cache-control": "no-cache, no-transform"})
    headers.pop("last-modified", None)
    headers.pop("content-length", None)
    matched = matches_tag(req.headers.get("if-none-match"), tag)
    return Response(
        None if matched else response.body, status_code=304 if matched else 200, headers=headers
    )
