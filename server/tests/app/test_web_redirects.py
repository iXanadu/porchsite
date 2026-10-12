"""Missing pages that moved: trailing slash and old stream addresses, and
www.<domain>. Port of cloudflare/test/redirects.test.ts."""

from server.app.builtin import redirect_for
from server.spec.site import view


def stream(id, path=""):
    return {"id": id, "path": path}


v = view(
    {"streams": [stream("journal", "reports"), stream("writing")]},
    [
        {"id": "a", "kind": "entry", "slug": "first", "data": {"title": "First", "date": "2026-10-01", "stream": "journal", "tags": []}},
        {"id": "b", "kind": "entry", "slug": "essay", "data": {"title": "Essay", "date": "2026-10-02", "stream": "writing", "tags": []}},
    ],
)  # fmt: skip


def test_adds_the_trailing_slash_to_real_pages_only():
    assert redirect_for(v, "/reports") == "/reports/"
    assert redirect_for(v, "/writing/essay") == "/writing/essay/"
    assert redirect_for(v, "/reports/tags/boats") == "/reports/tags/boats/"
    assert redirect_for(v, "/review") is None
    assert redirect_for(v, "/writing/nothing") is None
    assert redirect_for(v, "/reports/") is None


def test_sends_a_moved_streams_old_address_to_its_new_one():
    assert redirect_for(v, "/journal/") == "/reports/"
    assert redirect_for(v, "/journal") == "/reports/"
    assert redirect_for(v, "/journal/first/") == "/reports/first/"
    assert redirect_for(v, "/journal/first") == "/reports/first/"
    assert redirect_for(v, "/journal/gone/") is None


async def test_sends_www_to_the_bare_domain(http):
    r = await http.get("https://www.example.com/pages/x/?a=1")
    assert r.status_code == 301
    assert r.headers["location"] == "https://example.com/pages/x/?a=1"
    assert r.headers["x-porchsite-release"] == "test"


async def test_redirects_a_missing_slash_over_http(db, http):
    from server.app import content

    from .web import publish, who

    s = await content.create_item(db, who, "site", {"title": "Boats", "streams": [{"id": "journal", "title": "Log", "path": "log"}]}, None)  # fmt: skip
    e = await content.create_item(db, who, "entry", {"stream": "journal", "title": "Hull", "date": "2026-10-01"}, None)  # fmt: skip
    await publish(db, [s["id"], e["id"]])
    r = await http.get(f"/journal/{e['slug']}?x=1")
    assert r.status_code == 301
    assert r.headers["location"] == f"/log/{e['slug']}/?x=1"
    assert r.headers["cache-control"] == "max-age=3600"
    assert (await http.get("/log/nothing")).status_code == 404
