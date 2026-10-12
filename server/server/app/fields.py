"""What each kind is, and every field of every kind in plain words, for the
assistant (site_state's `kinds` and `fields`). The Cloudflare edition writes
the field guide from its zod schemas' descriptions (models.ts fieldGuide());
the server edition reads the same guide as data, regenerated from it by
server/scripts/cloudflare-contract.sh, and a test checks that it names exactly
the fields server/spec/models.py has.
"""

import json
from functools import cache
from pathlib import Path
from typing import Any

GUIDE = Path(__file__).with_name("field_guide.json")


@cache
def _guide() -> dict[str, Any]:
    return json.loads(GUIDE.read_text(encoding="utf-8"))


def kind_guide() -> dict[str, str]:
    return dict(_guide()["kinds"])


def field_guide() -> dict[str, dict[str, str]]:
    return {k: dict(v) for k, v in _guide()["fields"].items()}
