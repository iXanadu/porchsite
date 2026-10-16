"""Shared fixture and matching assertions: cloudflare/test/playbook.test.ts."""

import json
from pathlib import Path

import pytest

from server.app.content import validate
from server.spec import theme
from server.spec.site import view

FIXTURE = json.loads((Path(__file__).parents[3] / "spec" / "playbook-cards.json").read_text())


@pytest.mark.parametrize("with_regular", [False, True])
def test_aside_cards_keep_visible_content_and_hide_private_links(with_regular):
    rows = [{**row, "data": validate("card", row["data"])} for row in FIXTURE["items"]]
    if with_regular:
        rows.append({"id": "regular", "kind": "card", "slug": None, "data": validate("card", {"name": "Ordinary reference", "description": "Another reference.", "group": "Other", "link": "https://example.com/ordinary"})})
    html = theme.render("playbook", "home", theme.home_view(view(validate("site", FIXTURE["site"]), rows), "1", "https://example.com"))
    assert "Important reference" in html
    assert 'href="https://example.com/reference"' in html
    assert "Mentioned reference" in html
    assert "hidden-mention" not in html
    assert "Private reference" not in html
    assert "hidden-private" not in html
    if with_regular:
        assert "Ordinary reference" in html
        assert 'href="https://example.com/ordinary"' in html
