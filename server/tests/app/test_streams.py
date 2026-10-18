"""ST-1..3 paired with the native Worker streams tests."""

import asyncio
import json

import pytest
import pytest_asyncio

from server.app import approvals, changes, content, history, importer
from server.app.errors import ApiError
from server.app.theme import feed, search_index
from server.spec import theme
from server.spec.site import view

from .conftest import TABLES
from .test_private_site import blank, fixture, reader
from .test_private_site import browser_factory as browser_factory

ACTOR, ORIGIN = "assistant:test", "https://site.example"


def streams(n=9):
    return [
        {"id": f"part-{i}", "title": f"Part {i}", "sort": "title" if i == 0 else "date"}
        for i in range(n)
    ]


@pytest_asyncio.fixture(autouse=True)
async def clean(db):
    await db.execute(f"TRUNCATE {TABLES} RESTART IDENTITY")
    await db.execute("UPDATE auth_state SET owner_epoch=0,private_floor='' WHERE id=1")


async def publish(db, ids):
    a = await approvals.request(db, ACTOR, ids, "")
    await approvals.decide(db, a["id"], {id: {"decision": "approve"} for id in ids}, "", ORIGIN)


async def test_st1_bounds_approval_history_rollback_revert_legacy_projection(db):
    assert len(content.validate("site", {"streams": streams(64)})["streams"]) == 64
    with pytest.raises(ApiError):
        content.validate("site", {"streams": streams(65)})
    one = await content.create_item(
        db,
        ACTOR,
        "site",
        {
            "streams": streams(),
            "sections": ["part-8", "entries"],
            "archive": {"enabled": True, "title": "All reports"},
        },
        None,
    )
    assert len(one["data"]["streams"]) == 9
    assert not (await content.site_data(db, True))["archive"]["enabled"]
    await publish(db, ["site"])
    assert len((await content.site_data(db, True))["streams"]) == 9

    version = one["version"]
    with pytest.raises(ApiError):
        await importer.import_file(
            db,
            json.dumps(
                {
                    "porchsite_import": 1,
                    "items": [
                        {"kind": "entry", "data": {"title": "Must not save", "date": "2026-10-17"}},
                        {
                            "kind": "site",
                            "data": {
                                "streams": [
                                    {"id": "one", "title": "One", "path": "shared"},
                                    {"id": "two", "title": "Two", "path": "shared"},
                                ],
                                "sections": ["entries"],
                            },
                        },
                    ],
                }
            ),
        )
    assert (await content.get_item(db, "site"))["version"] == version
    assert await db.fetchval("SELECT count(*) FROM items") == 1
    p = (await history.publishes(db))[0]["id"]
    two = await content.update_item(
        db,
        ACTOR,
        "site",
        1,
        {"streams": streams(2), "sections": ["entries"], "archive": {"enabled": False}},
    )
    await publish(db, ["site"])
    back = await content.rollback(db, ACTOR, "site", 1, two["version"])
    assert len(back["data"]["streams"]) == 9
    await history.revert(db, p, "", ORIGIN)
    assert len((await content.site_data(db, True))["streams"]) == 9
    versions = await content.history(db, "site")
    assert len(next(v for v in versions if v["version"] == 1)["data"]["streams"]) == 9
    rows = await db.fetch(
        "SELECT data FROM items WHERE id='site' UNION ALL SELECT data FROM revisions WHERE item_id='site' UNION ALL SELECT data FROM live WHERE item_id='site'"
    )
    for row in rows:
        data = json.loads(row["data"])
        assert len(data["streams"]) <= 8 and len(data["sections"]) <= 12
        assert "archive" not in data
        assert all("sort" not in s for s in data["streams"])


async def test_st1_unseen_old_approval_and_edit_never_inherit_stale_write_no_side_effect(db):
    await content.create_item(
        db, ACTOR, "site", {"streams": streams(), "archive": {"enabled": True}}, None
    )
    await db.execute(
        "INSERT INTO live (item_id,kind,version,data,published_at) SELECT id,kind,version,data,updated_at FROM items WHERE id='site'"
    )
    assert len((await content.site_data(db, True))["streams"]) == 8
    assert not (await content.site_data(db, True))["archive"]["enabled"]
    await db.execute("UPDATE items SET version=2 WHERE id='site'")
    assert len((await content.get_item(db, "site"))["data"]["streams"]) == 8
    with pytest.raises(ApiError) as error:
        await content.update_item(db, ACTOR, "site", 1, {"title": "stale"})
    assert error.value.code == "version_conflict"
    assert await db.fetchval("SELECT count(*) FROM site_stream_settings") == 1


async def test_st1_retries_concurrent_writes_import_and_complete_approval_text(db):
    data = {
        "streams": streams(),
        "sections": ["part-8", "entries"],
        "archive": {"enabled": True, "title": "All reports"},
    }
    first = await content.create_item(db, ACTOR, "site", data, "streams-once")
    assert (await content.create_item(db, ACTOR, "site", data, "streams-once"))["version"] == 1
    assert await db.fetchval("SELECT count(*) FROM site_stream_settings") == 1
    results = await asyncio.gather(
        content.update_item(db, ACTOR, "site", 1, {"title": "First"}),
        content.update_item(db, ACTOR, "site", 1, {"title": "Second"}),
        return_exceptions=True,
    )
    assert sum(isinstance(r, dict) for r in results) == 1
    assert await db.fetchval("SELECT count(*) FROM site_stream_settings") == 2
    text = changes.field_rows("site", first["data"])
    assert "Part 8" in text and "By title" in text and "On · All reports" in text
    changed = changes.what_changed(
        "site",
        {**first["data"], "streams": [{**s, "sort": "date"} for s in streams()]},
        first["data"],
    )
    assert "Newest first" in changed and "By title" in changed
    await importer.import_file(
        db,
        json.dumps(
            {
                "porchsite_import": 1,
                "items": [{"kind": "site", "data": {"title": "Imported report site"}}],
            }
        ),
    )
    item = await content.get_item(db, "site")
    assert len(item["data"]["streams"]) == 9 and item["data"]["sections"] == ["part-8", "entries"]
    await publish(db, ["site"])
    assert len((await content.site_data(db, True))["streams"]) == 9


async def test_st2_published_only_filters_empty_escape_and_collision(db, http):
    await content.create_item(
        db,
        ACTOR,
        "site",
        {
            "title": "<Site>",
            "theme": "personal-homepage",
            "streams": [{"id": "one", "title": "<One>"}, {"id": "two", "title": "Two"}],
            "archive": {"enabled": True, "title": "<Archive>"},
        },
        None,
    )
    a = await content.create_item(
        db,
        ACTOR,
        "entry",
        {
            "stream": "one",
            "title": "<Visible>",
            "summary": "<Summary>",
            "date": "2026-10-17",
            "body": "FULL_BODY_NOT_LISTED",
            "tags": ["report", "report"],
        },
        None,
    )
    b = await content.create_item(
        db,
        ACTOR,
        "entry",
        {"stream": "two", "title": "Second", "date": "2026-10-16", "tags": ["other"]},
        None,
    )
    await content.create_item(
        db,
        ACTOR,
        "entry",
        {
            "title": "SECRET_DRAFT",
            "date": "2026-10-17",
            "status": "draft",
            "tags": ["secret-draft"],
        },
        None,
    )
    pending = await content.create_item(
        db,
        ACTOR,
        "entry",
        {"title": "SECRET_PENDING", "date": "2026-10-17", "tags": ["secret-pending"]},
        None,
    )
    card = await content.create_item(
        db,
        ACTOR,
        "card",
        {"name": "SECRET_CARD", "description": "Hidden card description", "visibility": "private"},
        None,
    )
    await publish(db, ["site", a["id"], b["id"], card["id"]])
    await approvals.request(db, ACTOR, [pending["id"]], "Pending report")
    unpublished = await content.create_item(
        db,
        ACTOR,
        "entry",
        {"title": "SECRET_UNPUBLISHED", "date": "2026-10-17", "tags": ["secret-unpublished"]},
        None,
    )
    await publish(db, [unpublished["id"]])
    await content.remove_item(db, ACTOR, unpublished["id"], 1)
    await publish(db, [unpublished["id"]])
    response = await http.get("/archive/")
    assert response.status_code == 200
    for secret in (
        "SECRET_DRAFT",
        "SECRET_PENDING",
        "SECRET_UNPUBLISHED",
        "SECRET_CARD",
        "secret-draft",
        "secret-pending",
        "secret-unpublished",
        "FULL_BODY_NOT_LISTED",
    ):
        assert secret not in response.text
    assert "&#60;Archive&#62;" in response.text and "&#60;Summary&#62;" in response.text
    assert "<Visible>" not in response.text and "report (1)" in response.text
    assert "form-action 'self'" in response.headers["Content-Security-Policy"]
    for query in ("stream=missing", "tag=missing", "stream=two&tag=report"):
        text = (await http.get("/archive/?" + query)).text
        assert "No entries match." in text and "&#60;Visible&#62;" not in text
    for query in (
        "sort=bogus",
        "tag=%3Cscript%3E",
        "unknown=1",
        "sort=date&sort=stream",
        "stream=bad/path",
    ):
        assert (await http.get("/archive/?" + query)).status_code == 400
    redirect = await http.get("/archive?tag=report")
    assert redirect.status_code == 301 and redirect.headers["Location"] == "/archive/?tag=report"
    sitemap = (await http.get("/sitemap.xml")).text
    assert "/archive/</loc>" in sitemap and "SECRET_" not in sitemap
    with pytest.raises(ApiError):
        await content.update_item(
            db, ACTOR, "site", 1, {"streams": [{"id": "archive", "title": "Conflict"}]}
        )

    await content.update_item(db, ACTOR, "site", 1, {"theme": "built-in"})
    await publish(db, ["site"])
    fallback = (await http.get("/archive/")).text
    assert 'href="/archive/?stream=one"' in fallback
    assert (await http.get("/archive/?stream=one")).status_code == 200


def test_st3_scalar_title_order_latest_and_feed_chronological():
    s = content.validate(
        "site", {"streams": [{"id": "one", "title": "One", "sort": "title", "layout": "feature"}]}
    )
    rows = [
        {
            "id": id,
            "kind": "entry",
            "slug": id,
            "data": content.validate(
                "entry", {"title": title, "date": date, "stream": "one", "tags": ["tag"]}
            ),
        }
        for id, title, date in [
            ("z", "Zulu", "2026-10-17"),
            ("a", "Alpha", "2026-10-16"),
            ("b", "Alpha", "2026-10-15"),
            ("c", "\U00010000", "2026-10-14"),
            ("d", "\ue000", "2026-10-13"),
        ]
    ]
    v = view(s, rows)
    home = theme.home_view(v, "test", ORIGIN)["sections"][0]
    assert [e["id"] for e in home["items"]] == ["a", "b", "z"]
    assert home["latest"][0]["id"] == "z"
    assert [e["id"] for e in theme.archive_view(v, "one", "test", ORIGIN)["entries"]] == [
        "a",
        "b",
        "z",
        "d",
        "c",
    ]
    assert theme.archive_view(v, "one", "test", ORIGIN, "tag")["entries"][0]["id"] == "a"
    assert json.loads(search_index(v, "one")["body"])[0]["t"] == "Alpha"
    assert feed(v, "one", ORIGIN)["body"].index("Zulu") < feed(v, "one", ORIGIN)["body"].index(
        "Alpha"
    )


async def test_st2_private_archive_gate_before_query_or_redirect_and_owner_reader_no_store(
    db, browser_factory
):
    own, _, item, _, _ = await fixture(db, browser_factory)
    await content.update_item(db, ACTOR, "site", item["version"], {"archive": {"enabled": True}})
    await publish(db, ["site"])
    read, _, _ = await reader(db, browser_factory)
    visitor = browser_factory()
    for path in (
        "/archive/",
        "/archive",
        "/archive/?sort=bogus",
        "/archive/?tag=%3Cscript%3E",
        "/archive/?stream=not-a-stream",
        "/archive/?unknown=1",
    ):
        for method in ("GET", "HEAD"):
            response = await visitor.at(path, method=method, headers={"If-None-Match": '"old"'})
            assert response.status_code == 404 and "Location" not in response.headers
            assert response.headers["Cache-Control"] == "private, no-store, no-transform"
            if method == "GET":
                blank(response)
            else:
                assert response.content == b""
            for browser in (own, read):
                response = await browser.at(path, method=method)
                assert response.headers["Cache-Control"] == "private, no-store, no-transform"
                assert response.status_code == (
                    301
                    if path == "/archive"
                    else 400
                    if any(t in path for t in ("bogus", "script", "unknown"))
                    else 200
                )

    for browser in (own, read):
        assert '<link rel="canonical" href="'+ORIGIN+'/archive/">' in (await browser.at('/archive/?stream=missing')).text
    for browser,authorized in ((own,True),(read,True),(visitor,False)):
        for path in ['/archive/?sort=bogus','/archive/index.md?tag=report','/archive/index.md?sort=bogus']:
            for method in ['GET','HEAD']:
                r = await browser.at(path,method=method,headers={'Accept':'text/markdown','If-None-Match':'*'})
                if authorized:
                    if 'bogus' in path:
                        assert r.status_code==400 and r.headers['cache-control']=='private, no-store, no-transform' and 'etag' not in r.headers
                    else:
                        assert r.status_code==304 and not r.content
                        assert r.headers['cache-control']=='private, no-cache, must-revalidate, no-transform' and r.headers['etag'].startswith('W/"ag-sha256-')
                else:
                    assert r.status_code==404 and r.content==(b'' if method=='HEAD' else b'<!doctype html><meta name="robots" content="noindex"><title></title><a href="/login?next=%2Freview">Sign in</a>')
                    assert r.headers['content-type']=='text/html; charset=utf-8' and r.headers['cache-control']=='private, no-store, no-transform'
                    assert not any(h in r.headers for h in ['etag','last-modified','link','vary'])
                assert not any(h in r.headers for h in ['content-signal','location'])
                if method=='HEAD':assert not r.content
    assert await db.fetchval('SELECT count(*) FROM public_artifacts')==0


async def test_af_combined_archive_filters_validators_and_map(db, http):
    await content.create_item(db, ACTOR, 'site', {'title':'Archive site','theme':'personal-homepage','ai_training_disabled':True,'streams':streams(),'sections':['entries'],'archive':{'enabled':True,'title':'All reports'}}, None)
    one = await content.create_item(db, ACTOR, 'entry', {'stream':'part-0','title':'First report','date':'2026-10-17','summary':'First summary','tags':['report']}, None)
    nine = await content.create_item(db, ACTOR, 'entry', {'stream':'part-8','title':'Ninth report','date':'2026-10-16','summary':'Ninth summary','tags':['other']}, None)
    await content.create_item(db, ACTOR, 'entry', {'stream':'part-8','title':'SECRET_DRAFT','date':'2026-10-18'}, None)
    await publish(db, ['site',one['id'],nine['id']])
    live = await content.site_data(db, True)
    assert len(live['streams']) == 9 and live['ai_training_disabled'] is True
    assert 'ai_training_disabled' not in await db.fetchval("SELECT data FROM live WHERE item_id='site'")
    query = '?tag=report&stream=part-0&sort=stream'
    canonical = '?sort=stream&stream=part-0&tag=report'
    html = await http.get('/archive/'+query)
    assert html.status_code == 200 and '/archive/index.md'+canonical in html.headers['link']
    assert '/archive/index.md?sort=stream&amp;stream=part-0&amp;tag=report' in html.text
    assert '<link rel="canonical" href="'+ORIGIN+'/archive/?sort=stream&amp;stream=part-0&amp;tag=report">' in html.text
    assert '<link rel="canonical" href="'+ORIGIN+'/archive/?stream=part-0&amp;tag=report">' in (await http.get('/archive/?sort=date&stream=part-0&tag=report')).text
    md = await http.get('/archive/'+query, headers={'Accept':'text/markdown'})
    assert '<'+ORIGIN+'/archive/'+canonical+'>' in md.text
    assert 'First report' in md.text and 'Ninth report' not in md.text and 'SECRET_DRAFT' not in md.text
    direct = await http.get('/archive/index.md'+canonical)
    assert direct.text == md.text and direct.headers['etag'] == md.headers['etag']
    tag = md.headers['etag']
    assert html.headers['etag'] != tag
    for path in ['/archive/'+query, '/archive/index.md'+canonical]:
        for method in ['GET','HEAD']:
            r = await http.request(method,path,headers={'Accept':'text/markdown','If-None-Match':tag})
            assert r.status_code == 304 and r.content == b''
    other = await http.get('/archive/index.md?stream=part-8')
    assert 'Ninth report' in other.text and other.headers['etag'] != tag
    for headers in [{'Cookie':'__Host-sk_owner=expired'},{'Cookie':'__Host-sk_reader=revoked'},{'Authorization':'Bearer invalid'}]:
        r = await http.get('/archive/index.md'+canonical,headers=headers)
        assert r.text == md.text and 'etag' not in r.headers
        assert r.headers['cache-control'] == 'private, no-store, no-transform'
    for query in ['?unknown=1','?sort=date&sort=stream','?tag=%3Cscript%3E']:
        r = await http.get('/archive/index.md'+query)
        assert r.status_code == 400 and 'etag' not in r.headers
    text = (await http.get('/llms.txt')).text
    assert text.index('/index.md') < text.index('/archive/index.md') and 'SECRET_DRAFT' not in text
    await content.update_item(db, ACTOR, 'site', 1, {'archive':{'enabled':False}})
    await publish(db, ['site'])
    missing = await http.get('/archive/index.md'+canonical,headers={'If-None-Match':tag})
    assert missing.status_code == 404 and 'etag' not in missing.headers
    assert '/archive/index.md' not in (await http.get('/llms.txt')).text


async def test_ar_archive_filter_exact_end(db, http):
    await content.create_item(db, ACTOR, 'site', {'title':'Archive site','theme':'personal-homepage','streams':streams(),'archive':{'enabled':True}}, None)
    await publish(db, ['site'])
    variants=[('/archive/','text/html'),('/archive/','text/markdown'),('/archive/index.md','text/markdown')]
    for key,value in [('tag','report'),('stream','part-0')]:
        for path,accept in variants:
            assert (await http.get(path+'?'+key+'='+value,headers={'Accept':accept})).status_code==200
            for ending in ['%0A','%0D%0A']:
                for method in ['GET','HEAD']:
                    response=await http.request(method,path+'?'+key+'='+value+ending,headers={'Accept':accept,'If-None-Match':'*'})
                    assert response.status_code==400
                    assert 'etag' not in response.headers and 'location' not in response.headers
                    if method=='HEAD': assert response.content==b''
