"""The owner's words over a look's own (SPEC §3 site `strings`, TEMPLATES §3).
Port of cloudflare/test/strings.test.ts."""

from datetime import UTC, datetime

import pytest

from server.app import builtin
from server.app.content import validate
from server.app.errors import ApiError
from server.spec import theme
from server.spec.blocks import hours_view
from server.spec.site import view
from server.spec.strings import STRINGS, strings_of

s = validate("site", {"title": "Kettle", "footer_line": "Fait main.", "strings": {"back_to_top": "Haut de page", "not_found_title": "Introuvable", "all_of": "", "open_now": "Ouvert"}})  # fmt: skip
v = view(s, [])


def test_lays_the_owners_words_over_the_defaults_an_empty_one_keeps_the_default():
    t = strings_of(s)
    assert t["back_to_top"] == "Haut de page"
    assert t["all_of"] == STRINGS["all_of"]
    assert t["read_full_entry"] == STRINGS["read_full_entry"]
    assert (
        theme.home_view(v, "1", "https://site.example")["strings"]["back_to_top"] == "Haut de page"
    )
    assert (
        theme.not_found_view(v, "1", "https://site.example")["meta"]["title"]
        == "Introuvable · Kettle"
    )


def test_reaches_the_blocks():
    h = {"weekly": [{"day": "mon", "open": "09:00", "close": "17:00", "closed": False}], "exceptions": [], "note": ""}  # fmt: skip
    now = datetime(2026, 10, 12, 10, tzinfo=UTC)
    assert hours_view(h, "UTC", now, strings_of(s))["status"] == "Ouvert · until 5:00 PM"


def test_refuses_a_name_no_look_uses():
    with pytest.raises(ApiError):
        validate("site", {"strings": {"back_to_tpo": "x"}})


def test_the_built_in_look_uses_the_footer_line_and_the_words_for_not_found():
    assert "<footer>Fait main.</footer>" in builtin.home(v).body.decode()
    nf = builtin.not_found(v).body.decode()
    assert "<title>Introuvable · Kettle</title>" in nf
    assert "<h1>Introuvable</h1>" in nf
