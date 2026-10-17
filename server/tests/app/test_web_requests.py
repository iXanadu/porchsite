"""Theme requests, the HTTP part: the queue checks a request came from this
site by fetching its proof from the site itself
(/.well-known/sitekeeper-proof/<nonce>), as the board does. Port of the route
part of cloudflare/test/requests.test.ts (the rest is test_requests.py)."""

from urllib.parse import urlsplit

from server.app import requests

from .test_requests import FakeQueue
from .web import who


class QueueOverHttp(FakeQueue):
    """The fake queue, asking the site over HTTP whether it sent the request."""

    def __init__(self, db, http):
        super().__init__(db)
        self.http = http

    async def proven(self, body) -> bool:
        origin = urlsplit(str(body.get("origin", "")))
        assert f"{origin.scheme}://{origin.netloc}" == "https://site.example"
        r = await self.http.get(f"/.well-known/sitekeeper-proof/{body.get('nonce', '')}")
        return r.status_code == 200 and r.text == "ok"


async def test_files_privately_and_the_queue_checks_with_the_site(db, http):
    q = QueueOverHttp(db, http)
    filed = await requests.file(
        db,
        "https://site.example",
        who,
        {"type": "business", "title": "Bakery with hours", "description": "Opening hours, a weekly specials list.", "examples": []},
        q,
    )  # fmt: skip
    assert filed["status"] == "open"
    q.group(filed["id"], "small-business-hours")
    q.answer("small-business-hours", "shopfront")
    mine = (await requests.mine(db, q))[0]
    assert (mine["id"], mine["status"], mine["theme"]) == (filed["id"], "answered", "shopfront")


async def test_a_proof_answers_once_and_only_for_this_site(db, http):
    nonce = await requests._new_proof(db)
    first = await http.get(f"/.well-known/sitekeeper-proof/{nonce}")
    assert (first.status_code, first.text) == (200, "ok")
    assert first.headers["cache-control"] == "no-store"
    again = await http.get(f"/.well-known/sitekeeper-proof/{nonce}")
    assert (again.status_code, again.text) == (404, "no")
    assert (await http.get(f"/.well-known/sitekeeper-proof/{'x' * 24}")).status_code == 404


async def test_robots(http):
    r = await http.get("/robots.txt")
    assert (
        r.text
        == f"User-agent: *\nAllow: /\nSitemap: {str(r.url).removesuffix('/robots.txt')}/sitemap.xml\n"
    )
    assert r.headers["cache-control"] == "public, no-cache, must-revalidate, no-transform"
