"""A look the assistant makes for one site: the same gates as a reviewed
theme, no scripts, and only that site has it. Port of
cloudflare/test/private-themes.test.ts."""

import json

import pytest

from server.app import approvals, content, site, themes
from server.app.errors import ApiError
from server.spec.theme import THEMES as THEMES_DIR

from .fakes import json_response

who = "assistant:test"
SAMPLE = json.loads((THEMES_DIR / "product-page" / "sample.json").read_bytes().decode("utf-8"))


async def no_catalog(url, method="GET", headers=None, content=None):
    return json_response(
        {"themes": [{"name": "taken-in-catalog", "package": {"url": "", "sha256": ""}}]}
    )


def base() -> dict:
    return themes.built_in()["product-page"]


def made(name: str, **over) -> dict:
    b = base()
    return {
        "manifest": {**b["manifest"], "name": name, "title": "Tea house"},
        "sample": SAMPLE,
        "pages": {**b["pages"], "home": b["pages"]["home"].replace("<h1>", '<h1 class="tea">', 1)},
        "partials": b["partials"],
        "css": f"{b['static']['site.css']}\n.tea{{letter-spacing:.02em}}",
        **over,
    }


async def refused(aw) -> ApiError:
    with pytest.raises(ApiError) as e:
        await aw
    return e.value


async def test_stores_a_sound_look_for_this_site_which_renders_once_approved(db):
    assert await themes.create(db, made("tea-house"), who, no_catalog) == {
        "name": "tea-house",
        "version": base()["manifest"]["version"],
    }
    assert (
        next(t for t in await themes.installed(db) if t["name"] == "tea-house")["source"]
        == "private"
    )
    s = await content.create_item(
        db, who, "site", {"title": "Tea", "tagline": "Steeped.", "theme": "tea-house"}, None
    )
    r = await approvals.request(db, who, [s["id"]], "")
    await approvals.decide(db, r["id"], {s["id"]: {"decision": "approve"}}, "")
    assert '<h1 class="tea">Steeped.</h1>' in await site.home_page(db, "https://site.example")


async def test_refuses_scripts_fixed_words_outside_addresses_and_taken_names(db):
    b = base()
    with_script = await refused(
        themes.create(
            db,
            made(
                "a-look",
                pages={
                    **b["pages"],
                    "home": f'{b["pages"]["home"]}<script src="/static/x.js"></script>',
                },
            ),
            who,
            no_catalog,
        )
    )
    assert with_script.code == "theme_problems"
    assert "scripts only from the site's kit" in with_script.message
    words = await refused(
        themes.create(
            db,
            made("b-look", pages={**b["pages"], "not_found": "<p>Oops, gone</p>"}),
            who,
            no_catalog,
        )
    )
    assert "fixed words (Oops, gone)" in words.message
    outside = await refused(
        themes.create(
            db,
            made("c-look", css="body{background:url(https://tracker.example/p.gif)}"),
            who,
            no_catalog,
        )
    )
    assert "outside address" in outside.message
    assert (
        await refused(themes.create(db, made("product-page"), who, no_catalog))
    ).code == "name_taken"
    assert (await refused(themes.create(db, made("classic"), who, no_catalog))).code == "name_taken"
    assert (
        await refused(themes.create(db, made("taken-in-catalog"), who, no_catalog))
    ).code == "name_taken"
