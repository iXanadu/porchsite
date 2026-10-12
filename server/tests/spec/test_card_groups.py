"""The owner says what kind a card group is; looks read it from by_group
(TEMPLATES §3). Port of cloudflare/test/card-groups.test.ts."""

import pytest

from server.app.content import validate
from server.app.errors import ApiError
from server.spec import theme
from server.spec.site import view


def card(id, name, group):
    return {"id": id, "kind": "card", "slug": None, "data": validate("card", {"name": name, "description": "x", "group": group})}  # fmt: skip


def test_carries_each_groups_style_and_a_flag_for_it():
    s = validate("site", {"title": "Shop", "card_groups": [{"name": "Questions", "style": "faq"}, {"name": "How it works", "style": "steps"}]})  # fmt: skip
    v = view(s, [card("c1", "Do you deliver?", "Questions"), card("c2", "Order", "How it works"), card("c3", "Bread", "Menu")])  # fmt: skip
    sec = next(
        x for x in theme.home_view(v, "1", "https://site.example")["sections"] if x.get("is_cards")
    )
    by = {g["label"]: g for g in sec["by_group"]}
    assert (
        by["Questions"]["style"] == "faq"
        and by["Questions"]["is_faq"]
        and not by["Questions"]["is_steps"]
    )
    assert by["How it works"]["is_steps"]
    assert by["Menu"]["style"] == "" and not any(
        by["Menu"][k] for k in ("is_faq", "is_steps", "is_reviews", "is_list")
    )


def test_refuses_an_unknown_style_and_a_group_named_twice():
    with pytest.raises(ApiError):
        validate("site", {"card_groups": [{"name": "A", "style": "gallery"}]})
    with pytest.raises(ApiError):
        validate(
            "site", {"card_groups": [{"name": "A", "style": "faq"}, {"name": "A", "style": "list"}]}
        )
