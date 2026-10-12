"""Fake fetchers: answers built in memory, as the Cloudflare tests build Responses."""

import json

import httpx


def json_response(v, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status, content=json.dumps(v).encode(), headers={"Content-Type": "application/json"}
    )


def text_response(text: str, status: int = 200) -> httpx.Response:
    return httpx.Response(status, content=text.encode("utf-8"))
