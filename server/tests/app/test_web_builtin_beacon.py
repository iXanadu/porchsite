"""The built-in look carries the kit's beacon, so a site on it is counted
(SPEC §8). Port of cloudflare/test/builtin-beacon.test.ts."""


async def test_loads_the_beacon_on_its_pages_and_lets_it_post_to_this_site_only(http):
    for path, kind in (("/", "home"), ("/nothing-here/", "notfound")):
        r = await http.get(path)
        assert f'<body data-kind="{kind}" data-id="">' in r.text
        assert '<script src="/static/a.js" defer></script></body>' in r.text
        assert "script-src 'self'; connect-src 'self'" in r.headers["content-security-policy"]
