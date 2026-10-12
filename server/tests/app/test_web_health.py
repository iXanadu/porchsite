"""/health (a server-edition extra, for the container's health check) and the
admin CLI's setup-code and check."""

import re

from server.app import cli
from server.app.settings import Settings

from .web import claimed


async def test_health_says_ok_with_the_release(http):
    r = await http.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "database": "ok", "release": "test"}
    assert r.headers["x-porchsite-release"] == "test"
    assert r.headers["cache-control"] == "no-store"
    head = await http.head("/health")
    assert head.status_code == 200 and head.content == b""


def test_setup_code_is_long_unambiguous_and_fresh():
    a, b = cli.setup_code(), cli.setup_code()
    assert a != b
    assert re.fullmatch(r"[a-km-np-z2-9]{5}(-[a-km-np-z2-9]{5}){4}", a)


async def test_check_passes_a_sound_install(db, fresh_tables):
    s = Settings(
        dsn=fresh_tables,
        setup_code=cli.setup_code(),
        site_url="https://example.com",
        release="1.2.3",
    )
    results = await cli.check(s)
    assert [lvl for lvl, _ in results if lvl != "ok"] == [], results
    assert any("schema current" in m for _, m in results)
    assert any("looks found" in m for _, m in results)


async def test_check_flags_what_is_wrong(db, fresh_tables):
    await claimed(db)
    s = Settings(
        dsn=fresh_tables, setup_code="still-here-after-claim", site_url="http://example.com/x"
    )
    out = dict((m, lvl) for lvl, m in await cli.check(s))
    assert (
        out["PORCHSITE_SITE_URL must be the bare address, no path: http://example.com/x"] == "fail"
    )
    assert any(lvl == "warn" and "remove it" in m for m, lvl in out.items())
    assert any(lvl == "warn" and "PORCHSITE_RELEASE" in m for m, lvl in out.items())


async def test_check_fails_without_a_database():
    results = await cli.check(Settings(dsn="postgresql://nobody@127.0.0.1:1/none"))
    assert results[0][0] == "fail" and "unreachable" in results[0][1]
