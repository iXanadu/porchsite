"""Fixed engine guide and caller-controlled reuse; no caller state is retained."""

import json
from importlib.resources import files

from .content import validate
from .fields import field_guide, kind_guide

STATES = {
    "live": "published, and the current version is what visitors see",
    "changed": "published, with a newer version that isn't approved yet",
    "new": "never published",
    "removal staged": "published, and removed here; the removal waits for approval",
    "removed": "removed and not published",
}
GUIDE_REVISION = json.loads(files(__package__).joinpath("site-state-guide.json").read_text())[
    "revision"
]
GUIDE_KEYS = ("states", "kinds", "fields", "site_defaults")


def fixed_guide():
    return {
        "states": STATES,
        "kinds": kind_guide(),
        "fields": field_guide(),
        "site_defaults": validate("site", {}),
    }


def with_guide(state, request=None):
    if request is None:
        return state
    included = request.get("known_revision") != GUIDE_REVISION
    answer = {k: v for k, v in state.items() if included or k not in GUIDE_KEYS}
    answer["guide"] = {"revision": GUIDE_REVISION, "included": included}
    return answer
