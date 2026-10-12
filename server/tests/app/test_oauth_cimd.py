"""An app named by its client metadata document (an https client_id): the
document is kept as long as its Cache-Control allows, at most a week, as the
Cloudflare edition's workers-oauth-provider does."""

import json

import httpx
import pytest

from server.app import oauth

CID = "https://app.example.com/client.json"


def serving(cache_control: str | None):
    calls = []

    async def fetcher(url, method="GET", headers=None, content=None):
        calls.append(url)
        doc = {
            "client_id": CID,
            "client_name": "App",
            "redirect_uris": ["https://app.example.com/cb"],
        }
        h = {"content-type": "application/json"}
        if cache_control is not None:
            h["cache-control"] = cache_control
        return httpx.Response(200, content=json.dumps(doc).encode(), headers=h)

    return fetcher, calls


@pytest.fixture(autouse=True)
def empty_cache():
    oauth._cimd_cache.clear()
    yield
    oauth._cimd_cache.clear()


async def test_keeps_a_document_its_cache_control_allows(monkeypatch):
    fetcher, calls = serving("public, max-age=600")
    monkeypatch.setattr(oauth, "cimd_fetch", fetcher)
    p = oauth.PgProvider(lambda: None)
    a = await p.get_client(CID)
    b = await p.get_client(CID)
    assert a.client_name == b.client_name == "App"
    assert calls == [CID]


@pytest.mark.parametrize(
    "cc", [None, "no-store", "public, max-age=600, no-cache", "private, max-age=600", "public"]
)
async def test_fetches_every_time_when_it_may_not_keep_it(monkeypatch, cc):
    fetcher, calls = serving(cc)
    monkeypatch.setattr(oauth, "cimd_fetch", fetcher)
    p = oauth.PgProvider(lambda: None)
    await p.get_client(CID)
    await p.get_client(CID)
    assert calls == [CID, CID]


def test_lifetime_prefers_s_maxage_and_caps_at_a_week():
    assert oauth._cache_ttl("max-age=60, s-maxage=120") == 120
    assert oauth._cache_ttl("max-age=99999999") == 7 * 86400
    assert oauth._cache_ttl("max-age=0") == 0
