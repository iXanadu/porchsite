import json
from pathlib import Path

from server.app import themes
from server.app.theme import render
from server.app.themecheck import rules
from server.spec.embeds import body_markdown
from server.spec.html import markdown
from server.spec.models import parse
from server.spec.sample import render_sample, sample_view
from server.spec.theme import home_view

ROOT = Path(__file__).parents[3]
SAMPLE = json.loads((ROOT / "themes/listing-page/sample.json").read_text())


def test_heading_ids_visible_text_collisions_and_opt_in():
    source = "## Video **tour**\n\n## [Video tour](https://example.com/private)\n\n### Café & garden\n\n## 你好\n\n## !!!\n\n## Video tour-2\n\n> ## A room\n\n- ## A room\n\n```\n## No anchor\n```"
    ordinary = markdown(source)
    html = markdown(source, heading_ids=True)
    assert "<h2 id=" not in ordinary
    for identifier in [
        "video-tour",
        "video-tour-2",
        "cafe-garden",
        "section",
        "section-2",
        "video-tour-2-2",
        "a-room",
        "a-room-2",
    ]:
        assert 'id="' + identifier + '"' in html
    assert 'id="no-anchor"' not in html
    view = {"entry": {"body": source, "body_html": body_markdown(source)}}
    mini = {"manifest": {}, "pages": {"entry": "{{{entry.body_html}}}"}, "partials": {}}
    assert render(mini, "entry", view) == ordinary
    assert render({**mini, "manifest": {"heading_ids": False}}, "entry", view) == ordinary
    assert render({**mini, "manifest": {"heading_ids": True}}, "entry", view) == html
    assert view["entry"]["body_html"] == ordinary


def test_heading_opt_in_keeps_engine_provenance_and_preview_fallback():
    source = "## Video tour\n\n!embed[Tour](https://example.com/player)"
    view = {"entry": {"body": source, "body_html": body_markdown(source)}}
    mini = {
        "manifest": {"heading_ids": True},
        "pages": {"entry": "{{{entry.body_html}}}"},
        "partials": {},
    }
    assert "<iframe " in render(
        mini, "entry", view, {"sources": ["https://example.com"], "origin": "https://site.example"}
    )
    assert "<iframe " not in render(mini, "entry", view)
    assert '<h2 id="video-tour">' in render(mini, "entry", view)


async def test_listing_pages_local_links_and_actual_photo_brief(db):
    t = await themes.load(db, "listing-page")
    assert rules("listing-page", t, True) == []
    assert "heading_ids must be a boolean" in rules(
        "listing-page", {**t, "manifest": {**t["manifest"], "heading_ids": "true"}}, True
    )
    pages = render_sample("listing-page", SAMPLE)
    assert len(pages) == 5
    home, entry = pages["index.html"], pages["listing/home/index.html"]
    for page in [home, entry]:
        for text in [
            'id="photos"',
            'id="video-tour"',
            'id="walk-through"',
            'id="open-house"',
            'class="stats"',
            'class="listing-body"',
            "owner@example.com",
            "https://maps.example/property",
        ]:
            assert text in page
    assert "$845,000" in home and "/listing/home/#video-tour" in home and "<iframe " not in home
    assert home.count("<img ") == 5
    art = await themes.needs(db, t)
    assert art["art"] == t["manifest"]["art"] and "actual property" in art["art"]["ask"]
    assert art["images"][0]["size"] == [2400, 1350]
    for path in ["/listing/home/#video-tour", "/#visit", "#photos"]:
        parse("site", {"cta_link": path, "links": [{"label": "Photos", "url": path}]})
    state = sample_view("listing-page", SAMPLE)
    assert state.entries
    live = render(
        t,
        "home",
        home_view(state, "1", "https://site.example"),
        {
            "sources": ["https://www.youtube-nocookie.com", "https://my.matterport.com"],
            "origin": "https://site.example",
        },
    )
    assert live.count("<iframe ") == 2
