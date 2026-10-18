"""Paired traversal-budget cases: stage-two-crawl.test.ts."""

import pytest

from server.app.check import check_site_deep as check_site
from server.app.content import validate
from server.spec.site import view

DATA = validate("site", {"title": "Test", "theme": "product-page", "sections": ["entries"]})
ENTRY = {
    "id": "orphan",
    "kind": "entry",
    "slug": "orphan",
    "data": validate("entry", {"title": "Orphan", "date": "2026-10-10", "body": "Body"}),
}

UNKNOWN = {**ENTRY, "id": "unknown", "slug": "unknown"}


def look(home):
    return {"manifest": {}, "partials": {}, "static": {}, "pages": {"home": home, "entry": "Entry"}}


@pytest.mark.parametrize("count", [199, 200])
def test_page_boundary(count):
    home = "".join(f'<a href="/missing-{i}/">Link</a>' for i in range(count))
    result = check_site(view(DATA, [ENTRY]), set(), look(home))
    if count == 199:
        assert "crawl" not in result
        assert [x["id"] for x in result["unreachable"]] == ["orphan"]
    else:
        assert result["ok"] is False and result["unreachable"] == []
        assert result["crawl"] == {
            "limit": "pages",
            "max_pages": 200,
            "max_links": 10000,
            "pages": 200,
            "links": 200,
        }


@pytest.mark.parametrize("count", [10000, 10001])
def test_link_boundary(count):
    result = check_site(
        view(DATA, [ENTRY]), set(), look('<a href="mailto:owner@example.com">Mail</a>' * count)
    )
    if count == 10000:
        assert "crawl" not in result
        assert [x["id"] for x in result["unreachable"]] == ["orphan"]
    else:
        assert result["ok"] is False and result["unreachable"] == []
        assert result["crawl"] == {
            "limit": "links",
            "max_pages": 200,
            "max_links": 10000,
            "pages": 1,
            "links": 10000,
        }


def test_inert_and_repeated_addresses():
    home = (
        '<template><a href="/missing/">Inert</a></template>' * 10001
        + '<a href="/">Home</a>' * 10000
    )
    result = check_site(view(DATA, []), set(), look(home))
    assert result["ok"] is True and "crawl" not in result


def test_preserves_broken_diagnostics():
    result = check_site(
        view({**DATA, "cta_link": "/missing/"}, [ENTRY]),
        set(),
        look('<a href="/">Home</a>' * 10001),
    )
    assert result["ok"] is False and result["unreachable"] == []
    assert result["broken"][0]["link"] == "/missing/"
    assert result["empty_sections"] == []
    assert result["crawl"]["limit"] == "links"


def test_global_link_budget():
    home = (
        '<a href="mailto:owner@example.com">Mail</a>' * 5000
        + '<a href="/journal/orphan/">Entry</a>'
    )
    theme = look(home)
    theme["pages"]["entry"] = '<a href="mailto:owner@example.com">Mail</a>' * 5000
    result = check_site(view(DATA, [ENTRY, UNKNOWN]), set(), theme)
    assert result["crawl"] == {
        "limit": "links",
        "max_pages": 200,
        "max_links": 10000,
        "pages": 2,
        "links": 10000,
    }
    assert result["ok"] is False and result["unreachable"] == []


def test_redirect_counts_before_destination():
    home = (
        "".join(f'<a href="/missing-{i}/">Link</a>' for i in range(198))
        + '<a href="/e/orphan/">Old address</a>'
    )
    result = check_site(view(DATA, [ENTRY, UNKNOWN]), set(), look(home))
    assert result["crawl"] == {
        "limit": "pages",
        "max_pages": 200,
        "max_links": 10000,
        "pages": 200,
        "links": 199,
    }
    assert result["ok"] is False and result["unreachable"] == []
