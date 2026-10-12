"""site_check finds links that lead nowhere and empty sections (SPEC §4).
Port of cloudflare/test/check.test.ts."""

from server.app.check import check_site
from server.app.content import validate
from server.spec.site import view

s = validate("site", {"title": "Lunch club", "cta_label": "Join the lunch", "cta_link": "/journal/monthly-lunch/", "buttons": [{"label": "Projects", "url": "/#cards", "note": ""}], "streams": [{"id": "updates", "title": "Updates", "path": "news"}], "sections": ["entries", "cards", "about"]})  # fmt: skip


def entry(id, slug, body):
    return {"id": id, "kind": "entry", "slug": slug, "data": validate("entry", {"title": id, "date": "2026-10-10", "body": body, "tags": ["lunch"]})}  # fmt: skip


def test_reports_links_that_lead_nowhere_and_sections_with_nothing_in_them():
    v = view(s, [entry("e1", "monthly-lunch", "See [the lunch](/news/monthly-lunch/), [tea](/news/tags/lunch/) and ![a photo](/media/abc.jpg). Also [old](/news/gone/) and ![missing](/media/nope.jpg).")])  # fmt: skip
    r = check_site(v, {"abc.jpg"})
    assert r["ok"] is False
    assert r["broken"] == [
        {"where": "site cta_link", "link": "/journal/monthly-lunch/", "why": "no page at that address"},
        {"where": "site buttons[0] url", "link": "/#cards", "why": "the home page has no section #cards with anything in it"},
        {"where": "entry e1 body", "link": "/news/gone/", "why": "no page at that address"},
        {"where": "entry e1 body", "link": "/media/nope.jpg", "why": "this site has no picture by that name"},
    ]  # fmt: skip
    assert r["empty_sections"] == ["cards", "about"]


def test_passes_a_site_whose_links_all_land():
    ok = validate("site", {"title": "Ok", "cta_label": "Read", "cta_link": "/news/hello/", "streams": [{"id": "updates", "title": "Updates", "path": "news"}], "sections": ["entries"]})  # fmt: skip
    assert check_site(view(ok, [entry("e1", "hello", "Back [home](/#updates).")]), set()) == {"ok": True, "broken": [], "empty_sections": []}  # fmt: skip
