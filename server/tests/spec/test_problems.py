"""A refusal is worded the same in both editions. Port of
cloudflare/test/problems.test.ts (same table)."""

import pytest

from server.app.content import validate
from server.app.errors import ApiError

CASES = [
    ("site", {"tagline": "x" * 161}, "tagline", "Too big: expected string to have <=160 characters"),
    ("site", {"title": ""}, "title", "Too small: expected string to have >=1 characters"),
    ("site", {"tagline": 3}, "tagline", "Invalid input: expected string, received number"),
    ("site", {"links": {}}, "links", "Invalid input: expected array, received object"),
    ("site", {"links": [{"label": "a", "url": "/a"}] * 9}, "links", "Too big: expected array to have <=8 items"),
    ("card", {"name": "A", "sort": 1.5}, "sort", "Invalid input: expected int, received number"),
    ("card", {"name": "A", "sort": "1"}, "sort", "Invalid input: expected number, received string"),
    ("card", {"name": "A", "sort": -1}, "sort", "Too small: expected number to be >=0"),
    ("card", {"name": "A", "sort": 10001}, "sort", "Too big: expected number to be <=10000"),
]  # fmt: skip


@pytest.mark.parametrize(("kind", "data", "field", "problem"), CASES)
def test_problems(kind, data, field, problem):
    with pytest.raises(ApiError) as e:
        validate(kind, data)
    assert {"field": field, "problem": problem} in e.value.extra["problems"]
