"""Review regressions: port of stage-one-regressions.test.ts."""
import pytest

from server.app.check import check_site
from server.app.content import validate
from server.spec.site import view

DATA = validate("site", {"title": "Test", "theme": "product-page", "sections": ["entries"]})


def entry(external_url=""):
    return {"id": "entry", "kind": "entry", "slug": "entry", "data": validate("entry", {"title": "Entry", "date": "2026-10-10", **({"external_url": external_url} if external_url else {"body": "Full body"})})}


def look(home):
    return {"manifest": {}, "partials": {}, "static": {}, "pages": {"home": home, "entry": "Entry"}}


@pytest.mark.parametrize("home", [
    '<template><template></template><a href="/journal/entry/">Inert</a></template>',
    '<template><template></template>{{#sections}}{{#latest}}{{{body_html}}}{{/latest}}{{/sections}}</template>',
])
def test_ignores_links_and_inline_bodies_within_a_nested_template(home):
    result = check_site(view(DATA, [entry()]), set(), look(home))
    assert result["ok"] is False
    assert [x["id"] for x in result["unreachable"]] == ["entry"]


@pytest.mark.parametrize("stored,rendered", [
    ("https://example.com", "https://example.com/"),
    ("https://EXAMPLE.com:443", "https://example.com/"),
    ("https://example.com/", "HTTPS://EXAMPLE.COM:443"),
    ("https://EXAMPLE.com:443/article", "https://example.com/article"),
])
def test_matches_equivalent_stored_and_rendered_destinations(stored, rendered):
    result = check_site(view(DATA, [entry(stored)]), set(), look(f'<a href="{rendered}">External</a>'))
    assert result["ok"] is True
    assert result["unreachable"] == []
