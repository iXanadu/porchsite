"""The port of the Cloudflare view layer (server/spec): expected values were
taken from the Cloudflare edition's own functions."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from server.spec import mustache
from server.spec.blocks import event_view, hours_view
from server.spec.html import esc, markdown
from server.spec.models import parse

# The shared table: the Cloudflare edition's tests read the same file, so the
# two renderers can't drift apart.
MD = json.loads((Path(__file__).parents[3] / "spec" / "markdown-cases.json").read_text("utf-8"))


def test_markdown_cases_present():
    assert len(MD) >= 40


@pytest.mark.parametrize("case", MD, ids=[c["name"] for c in MD])
def test_markdown(case):
    assert markdown(case["markdown"]) == case["html"]


def test_esc_uses_numeric_entities():
    assert esc("a&b<\"'>") == "a&#38;b&#60;&#34;&#39;&#62;"


HOURS = {
    "weekly": [
        {"day": d, "open": "09:00", "close": "17:00", "closed": False}
        for d in ["mon", "tue", "wed", "thu", "fri"]
    ],
    "exceptions": [
        {
            "from": "2026-10-19",
            "to": "",
            "label": "Holiday",
            "open": "",
            "close": "",
            "closed": True,
        }
    ],
    "note": "",
}


@pytest.mark.parametrize(
    ("now", "status"),
    [
        ("2026-10-15T15:30:00Z", "Open now · until 5:00 PM"),  # Thursday 10:30 in Chicago
        ("2026-10-17T15:30:00Z", "Closed now · opens Tue 9:00 AM"),  # Saturday; Monday is a holiday
        ("2026-10-15T23:30:00Z", "Closed now · opens Fri 9:00 AM"),  # Thursday evening
    ],
)
def test_hours_status(now, status):
    v = hours_view(HOURS, "America/Chicago", datetime.fromisoformat(now.replace("Z", "+00:00")))
    assert v["status"] == status
    assert v["exceptions"] == [{"label": "Holiday", "when": "Mon, Oct 19", "hours": "Closed"}]
    assert [d["today"] for d in v["days"]].index(True) == (3 if now.startswith("2026-10-15") else 5)


def test_event_zone_and_past():
    ev = parse(
        "entry",
        {
            "title": "x",
            "date": "2027-06-11",
            "event": {"start": "2027-06-11T19:00", "end": "2027-06-11T23:00"},
        },
    )["event"]
    v = event_view(ev, "America/Chicago", datetime(2026, 10, 15, 15, 30, tzinfo=UTC))
    assert v["when"] == "Friday, June 11, 2027 · 7:00 PM – 11:00 PM CT"
    assert v["is_past"] is False


def test_site_defaults():
    s = parse("site", {})
    assert s["title"] == "My site"
    assert s["timezone"] == "UTC"
    assert s["sections"] == ["entries", "cards", "notes", "about"]
    assert s["streams"][0]["id"] == "journal" and s["streams"][0]["layout"] == "list"
    assert s["contact"]["address"]["city"] == ""
    assert parse("card", {"name": " A ", "description": "b"})["sort"] == 100
    assert parse("card", {"name": " A ", "description": "b"})["name"] == "A"


def test_models_refuse_what_zod_refuses():
    with pytest.raises(ValidationError):
        parse("note", {"text": "x", "date": "2026-10-08", "typo": 1})
    with pytest.raises(ValidationError):
        parse("site", {"streams": [{"id": "media", "title": "x"}]})
    with pytest.raises(ValidationError):
        parse("card", {"name": "a", "description": "b", "link": "http://example.com"})
    with pytest.raises(ValidationError):
        parse(
            "entry",
            {"title": "a", "date": "2026-10-08", "event": {"start": "2026-10-08", "status": "on"}},
        )


def test_mustache_js_quirks():
    # A partial that is the first tag on its line is indented by the width
    # of the text before it; a line of only section tags loses its newline.
    out = mustache.render(
        "<div>{{> p}}</div>\n{{#a}}{{#b}}\nx\n{{/b}}{{/a}}\n", {"a": True, "b": {}}, {"p": "1\n2\n"}
    )
    assert out == "<div>1\n     2\n</div>\nx\n"
    # A dotted name that fails in one context is tried in the ones below.
    assert mustache.render("{{#e}}{{s.u}}{{/e}}", {"e": {"s": "str"}, "s": {"u": "ok"}}) == "ok"
    assert mustache.render("[{{missing}}][{{n}}][{{t}}]", {"n": None, "t": True}) == "[][][true]"
