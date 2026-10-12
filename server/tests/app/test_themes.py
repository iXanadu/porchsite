"""Themes from the catalog: installed only from it, checked against it, and
what a theme needs from the site. Port of cloudflare/test/themes.test.ts."""

import hashlib
import json

import pytest

from server.app import approvals, content, media, site, themes
from server.app.errors import ApiError

from .fakes import json_response, text_response

who = "assistant:test"


def built(name: str) -> dict:
    return themes.built_in()[name]


def catalog(tamper: bool = False):
    """A catalog with one theme, "harbor": product-page under another name, saying so in its home page."""
    b = built("product-page")
    pkg = json.dumps(
        {
            **b,
            "manifest": {**b["manifest"], "name": "harbor", "version": "2.0.0"},
            "pages": {**b["pages"], "home": "HARBOR {{site.tagline}}"},
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    total = hashlib.sha256(pkg.encode()).hexdigest()

    async def fetcher(url, method="GET", headers=None, content=None):
        if url == themes.CATALOG_URL:
            return json_response(
                {
                    "themes": [
                        {
                            "name": "harbor",
                            "type": "product",
                            "package": {"url": "https://cat.example/harbor.json", "sha256": total},
                        }
                    ]
                }
            )
        if url == "https://cat.example/harbor.json":
            return text_response(pkg.replace("HARBOR", "EVIL") if tamper else pkg)
        return text_response("", 404)

    return fetcher


async def test_installs_a_catalog_theme_and_the_site_renders_with_it_once_approved(db):
    assert await themes.install(db, "harbor", who, catalog()) == {
        "name": "harbor",
        "version": "2.0.0",
    }
    assert next(t for t in await themes.installed(db) if t["name"] == "harbor") == {
        "name": "harbor",
        "version": "2.0.0",
        "source": "installed",
    }
    s = await content.create_item(
        db, who, "site", {"title": "Boats", "tagline": "Built by hand.", "theme": "harbor"}, None
    )
    req = await approvals.request(db, who, [s["id"]], "")
    await approvals.decide(db, req["id"], {s["id"]: {"decision": "approve"}}, "")
    assert await site.home_page(db, "https://site.example") == "HARBOR Built by hand."


async def test_keeps_the_old_names_working(db):
    assert (await themes.load(db, "classic"))["manifest"]["name"] == "personal-homepage"
    assert (await themes.load(db, "broadsheet"))["manifest"]["name"] == "product-page"


async def test_refuses_a_download_that_doesnt_match_and_themes_not_in_it(db):
    with pytest.raises(ApiError) as bad:
        await themes.install(db, "harbor", who, catalog(True))
    assert bad.value.code == "bad_download"
    with pytest.raises(ApiError) as none:
        await themes.install(db, "nope", who, catalog())
    assert none.value.code == "no_such_theme"


def test_refuses_a_package_that_isnt_a_whole_theme():
    b = built("product-page")
    whole = {**b, "manifest": {**b["manifest"], "name": "x"}}
    themes.check("x", whole, 10)
    with pytest.raises(ApiError, match="says it's x"):
        themes.check("y", whole, 10)
    with pytest.raises(ApiError, match="no entry page"):
        themes.check("x", {**whole, "pages": {"home": ""}}, 10)
    with pytest.raises(ApiError, match="named"):
        themes.check("x", {**whole, "static": {"site.css": "", "../evil": ""}}, 10)
    with pytest.raises(ApiError, match="1 MB"):
        themes.check("x", whole, 2_000_000)


async def test_says_what_a_theme_needs_and_whats_the_wrong_shape(db):
    # A 2x1 PNG as the mark: product-page wants a square.
    png = bytes(
        [
            0x89,
            0x50,
            0x4E,
            0x47,
            0x0D,
            0x0A,
            0x1A,
            0x0A,
            0,
            0,
            0,
            13,
            0x49,
            0x48,
            0x44,
            0x52,
            0,
            0,
            2,
            0,
            0,
            0,
            1,
            0,
            8,
            2,
            0,
            0,
            0,
        ]
    )
    m = await media.store(db, png, "image/png", "test")
    s = await content.get_item(db, "site")
    await content.update_item(
        db,
        who,
        "site",
        s["version"],
        {
            "title": "Kettle",
            "tagline": "Tea.",
            "theme": "product-page",
            "logo": m,
            "logo_alt": "A kettle",
        },
    )
    n = await themes.needs(db, built("product-page"))

    def slot(f):
        return next(x for x in n["images"] if x["field"] == f)

    assert slot("site.hero")["status"] == "missing"
    assert slot("site.logo")["status"] == "wrong shape: it's 512x256 (wide), needs 512x512"
    assert slot("body")["status"] == "per item: check each one"
    assert next(x for x in n["content"] if x["field"] == "site.tagline")["status"] == "filled"
    assert next(x for x in n["content"] if x["field"] == "site.hero_caption")["status"] == "missing"
    assert n["type"] == "product"
    assert len(n["art"]["steps"]) > 3
    assert "{subject}" in slot("site.logo")["prompt"]
