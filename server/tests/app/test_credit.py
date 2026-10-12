"""Credit for a look's maker: an X handle and nothing else. The manifest's
author_x (themecheck), theme_submit's author_x passed to the queue and its
claim code passed back, and author_x in theme_list's catalog. Port of the
site-side parts of cloudflare/test/credit.test.ts; the queue's own claim,
verification and removal are tested with the board (cloudflare edition)."""

import json

import pytest

from server.app import mcp, requests, themecheck, themes
from server.spec.theme import THEMES as THEMES_DIR

from .test_requests import ORIGIN, FakeQueue, who
from .test_web_mcp import assistant

BASE = themes.built_in()["product-page"]


def author_problems(extra):
    t = {**BASE, "manifest": {**BASE["manifest"], **extra}}
    return [
        p
        for p in themecheck.rules("product-page", t, scripts=True)
        if "author" in p or "credit" in p or "X handle" in p
    ]


def test_author_x_is_an_x_handle_and_the_only_author_field():
    assert author_problems({}) == []
    assert author_problems({"author_x": "maker_01"}) == []
    assert author_problems({"author_x": "a" * 15}) == []
    for bad in ["@maker", "", "a" * 16, "has space", "dash-ed", 42]:
        assert len(author_problems({"author_x": bad})) == 1, bad
    for other in ["author", "author_name", "author_email", "author_url", "email", "homepage", "website", "url", "creator", "twitter"]:  # fmt: skip
        assert author_problems({other: "x"}) == [
            f"{other}: credit is an X handle in author_x and nothing else (no names, emails or links)"
        ]


def test_no_built_in_look_carries_an_author_field():
    for name, t in themes.built_in().items():
        assert [k for k in t["manifest"] if "author" in k.lower()] == [], name


def test_theme_list_shows_author_x_when_credited():
    a, b, c = themes.listing(
        [
            {
                "name": "one",
                "slots": {"images": [{}, {}]},
                "package": {},
                "author": {"x": "maker_01"},
            },  # fmt: skip
            {"name": "two", "slots": {}, "package": {}},
            {"name": "three", "package": {}, "author": {"x": "not a handle"}},
        ]
    )
    assert a == {"name": "one", "needs_images": 2, "author_x": "maker_01"}
    assert b == {"name": "two", "needs_images": 0}
    assert c == {"name": "three", "needs_images": 0}


async def make_look(db, name, manifest_x=None):
    sample = json.loads((THEMES_DIR / "product-page" / "sample.json").read_text(encoding="utf-8"))

    async def empty_catalog(url, method="GET", headers=None, content=None):
        from .fakes import json_response

        return json_response({"themes": []})

    manifest = {**BASE["manifest"], "name": name, **({"author_x": manifest_x} if manifest_x else {})}  # fmt: skip
    await themes.create(
        db,
        {
            "manifest": manifest,
            "sample": sample,
            "pages": BASE["pages"],
            "partials": BASE["partials"],
            "css": BASE["static"]["site.css"],
        },  # fmt: skip
        who,
        empty_catalog,
    )


async def test_submit_passes_the_claim_and_returns_the_claim_code(db):
    q = FakeQueue(db)
    await make_look(db, "tea-house")
    s = await requests.submit(db, ORIGIN, who, "tea-house", "For tea rooms: a menu-led front page.", q, author_x="maker_01")  # fmt: skip
    code = s["credit"]["claim_code"]
    assert (
        s["credit"]
        == {
            "author_x": "maker_01",
            "claim_code": code,
            "instructions": f"To be credited, post this from @maker_01 on X: 'Porchsite look tea-house: {code}'. The curator checks it before the look is published with your name; until then it is published without credit.",  # fmt: skip
        }
    )
    assert q.submissions[s["id"]]["author_x"] == "maker_01"
    plain = await requests.submit(db, ORIGIN, who, "tea-house", "For tea rooms: a menu-led front page.", q)  # fmt: skip
    assert "credit" not in plain
    assert q.submissions[plain["id"]]["author_x"] == ""


async def test_theme_submit_takes_an_optional_x_handle(db, http, monkeypatch):
    q = FakeQueue(db)
    real = requests.submit

    async def via_fake_queue(*args, **kw):
        return await real(*args, fetcher=q, **kw)

    monkeypatch.setattr(requests, "submit", via_fake_queue)
    await make_look(db, "tea-house")
    a = await assistant(db, http)
    note = "For tea rooms: a menu-led front page."
    err, bad, _ = await a.call("theme_submit", name="tea-house", note=note, author_x="@maker")
    assert err and "author_x" in bad
    err, got, _ = await a.call("theme_submit", name="tea-house", note=note, author_x="maker_01")
    assert not err
    assert got["credit"]["author_x"] == "maker_01"
    assert "credit.instructions" in got["next"]
    err, plain, _ = await a.call("theme_submit", name="tea-house", note=note)
    assert not err and "credit" not in plain
    assert (
        plain["next"]
        == "Tell your person it's been sent for review; you'll see its status in theme_list."
    )
    schema = mcp._BY_NAME["theme_submit"]["inputSchema"]
    assert schema["required"] == ["name", "note"]
    assert schema["properties"]["author_x"]["pattern"] == "^[A-Za-z0-9_]{1,15}$"


async def test_the_sharing_site_sees_where_its_claim_stands(db):
    """The board's side (credit from the curator's checks, never the handle or
    the code) is tested with the board; here the site passes it on."""
    q = FakeQueue(db)
    await make_look(db, "tea-house")
    note = "For tea rooms: a menu-led front page."
    credited = await requests.submit(db, ORIGIN, who, "tea-house", note, q, author_x="maker_01")
    dropped = await requests.submit(db, ORIGIN, who, "tea-house", note, q, author_x="maker_02")
    plain = await requests.submit(db, ORIGIN, who, "tea-house", note, q)

    async def mine():
        return {x["id"]: x for x in await requests.my_submissions(db, q)}

    m = await mine()
    assert (m[credited["id"]]["status"], m[credited["id"]]["credit"]) == ("new", "waiting")
    assert m[dropped["id"]]["credit"] == "waiting"
    assert "credit" not in m[plain["id"]]
    q.submissions[credited["id"]].update(state="published", credit="credited")
    q.submissions[dropped["id"]].update(state="rejected", note="Too close.", credit="not credited")
    m = await mine()
    assert (m[credited["id"]]["status"], m[credited["id"]]["credit"]) == ("published", "credited")
    assert (m[dropped["id"]]["status"], m[dropped["id"]]["credit"]) == ("rejected", "not credited")
    assert list(m[dropped["id"]]) == ["id", "name", "version", "created_at", "status", "note", "credit"]  # fmt: skip
    # Only the credit words it knows.
    q.submissions[credited["id"]]["credit"] = "maybe"
    assert "credit" not in (await mine())[credited["id"]]


@pytest.mark.parametrize("handle", ["maker_01", "A"])
async def test_a_claim_in_the_manifest_reaches_the_queue(db, handle):
    q = FakeQueue(db)
    await make_look(db, "tea-garden", manifest_x=handle)
    s = await requests.submit(db, ORIGIN, who, "tea-garden", "For tea rooms: a menu-led front page.", q)  # fmt: skip
    assert s["credit"]["author_x"] == handle
