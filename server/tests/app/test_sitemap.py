import json
import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

from server.app import content, themes
from server.spec.models import parse
from server.spec.site import view
from server.spec.sitemap import SITEMAP_HEADERS, robots, sitemap

from .web import publish, who

CASES = json.loads((Path(__file__).parents[3] / "spec/sitemap-cases.json").read_text())
ORIGIN = "https://site.example"


@pytest.fixture(autouse=True)
async def clean(db):
    await db.execute(
        "TRUNCATE site_embed_sources, approvals, publishes, live, revisions, items, idempotency, themes"
    )


def test_shared_sitemap_xml_and_missing_dates():
    v = view(
        parse("site", CASES["site"]),
        [{**r, "slug": r.get("slug"), "data": parse(r["kind"], r["data"])} for r in CASES["rows"]],
    )
    v.approved_at = CASES["approved_at"]
    rows = "".join(
        f"<url><loc>{ORIGIN}{r['path']}</loc><lastmod>{r['lastmod']}</lastmod></url>\n"
        for r in CASES["expected"]
    )
    assert (
        sitemap(v, ORIGIN)
        == '<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + rows
        + "</urlset>\n"
    )
    fallback = sitemap(v, ORIGIN, False)
    assert (
        fallback.count("<loc>") == 2 and "/outside/" not in fallback and "/draft/" not in fallback
    )
    v.approved_at = {}
    assert "<lastmod>" not in sitemap(v, ORIGIN)
    assert robots(ORIGIN) == f"User-agent: *\nAllow: /\nSitemap: {ORIGIN}/sitemap.xml\n"


async def test_published_http_paths_dates_draft_edits_head_and_feed_cache(db, http):
    async def make(kind, data):
        return await content.create_item(db, who, kind, data, None)

    site = await make(
        "site",
        {
            "theme": "personal-homepage",
            "streams": [
                {"id": "journal", "title": "Journal", "path": "writing"},
                {"id": "empty", "title": "Empty"},
            ],
        },
    )
    local = await make("entry", {"title": "Local", "date": "1999-01-01", "tags": ["alpha"]})
    external = await make(
        "entry",
        {
            "title": "External",
            "date": "2000-01-01",
            "external_url": "https://outside.example/article",
            "tags": ["external-only"],
        },
    )
    hidden = await make("entry", {"title": "Hidden", "date": "2099-01-01"})
    await publish(db, [site["id"], local["id"], external["id"]])
    response = await http.get("/sitemap.xml")
    body = response.text
    origin = str(response.url).removesuffix("/sitemap.xml")
    assert response.status_code == 200
    for k, v in SITEMAP_HEADERS.items():
        assert response.headers[k] == v
    locs = re.findall(r"<loc>([^<]+)</loc>", body)
    for loc in locs:
        assert (await http.get(loc)).status_code == 200
    assert origin + "/empty/" in locs and origin + "/writing/" + local["slug"] + "/" in locs
    assert hidden["slug"] not in body and external["slug"] + "/" not in body
    assert not any(
        x in body
        for x in ["/review", "/setup", "/login", "outside.example", "<lastmod>1999-01-01</lastmod>"]
    )
    at = await db.fetchval("SELECT published_at FROM live WHERE item_id=$1", local["id"])
    assert (
        f"<lastmod>{datetime.fromisoformat(at.replace('Z', '+00:00')).astimezone(UTC).date().isoformat()}</lastmod>"
        in body
    )
    await content.update_item(db, who, local["id"], local["version"], {"body": "Not approved"}, "")
    assert (await http.get("/sitemap.xml")).text == body
    head = await http.head("/sitemap.xml")
    assert (
        head.status_code == 200
        and head.text == ""
        and head.headers["content-type"] == response.headers["content-type"]
    )
    assert (
        head.headers["cache-control"]
        == (await http.get("/writing/feed.xml")).headers["cache-control"]
    )
    assert (await http.get("/robots.txt")).text == robots(origin)


async def test_missing_look_omits_unreachable_archive_and_tags(db, http):
    site = await content.create_item(db, who, "site", {"theme": "unavailable-look"}, None)
    entry = await content.create_item(
        db, who, "entry", {"title": "Local", "date": "2026-10-10", "tags": ["tag"]}, None
    )
    await publish(db, [site["id"], entry["id"]])
    body = (await http.get("/sitemap.xml")).text
    assert body.count("<loc>") == 2 and "/tags/" not in body


async def test_installed_private_look_archives_and_builtin_aliases(db, http):
    assert themes.is_built_in("classic") and not themes.is_built_in("fixture-look")
    base = themes.built_in()["personal-homepage"]
    t = {**base, "manifest": {**base["manifest"], "name": "fixture-look"}}
    await db.execute(
        "INSERT INTO themes(name,version,package,sha256,installed_at,installed_by,source) VALUES('fixture-look','1',$1,'fixture','2026','owner','private')",
        json.dumps(t),
    )
    site = await content.create_item(db, who, "site", {"theme": "fixture-look"}, None)
    entry = await content.create_item(
        db, who, "entry", {"title": "Local", "date": "2026-10-10", "tags": ["tag"]}, None
    )
    await publish(db, [site["id"], entry["id"]])
    response = await http.get("/sitemap.xml")
    origin = str(response.url).removesuffix("/sitemap.xml")
    assert (
        origin + "/journal/</loc>" in response.text
        and origin + "/journal/tags/tag/</loc>" in response.text
    )
    assert (await http.get("/journal/tags/tag/")).status_code == 200
