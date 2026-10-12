"""pytest plugin for scripts/upgrade-check.sh (loaded with -p new_schema).

The PREVIOUS release's server tests run with this plugin: whenever they build
or open a database (server.app.db.apply_schema), the NEW release's schema is
applied first (PORCHSITE_NEW_DB_PY names the new db.py), then the previous
release's own apply_schema runs on top, as it does when a rolled-back app
starts. So the previous code is tested on the new schema, which is what a
rollback leaves behind.
"""

import importlib.util
import os

import server.app.db as previous

_spec = importlib.util.spec_from_file_location(
    "porchsite_new_db", os.environ["PORCHSITE_NEW_DB_PY"]
)
assert _spec and _spec.loader
new = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(new)

_previous_apply = previous.apply_schema
_said = False


async def apply_schema(db):
    global _said
    await new.apply_schema(db)
    if not _said:
        _said = True
        names = [n for n, _ in new.MIGRATIONS]
        # pytest captures fixture output, so the proof goes to a file.
        with open(os.environ["PORCHSITE_UPGRADE_MARK"], "a", encoding="utf-8") as f:
            f.write(
                f"upgrade-check: server databases got the new schema first ({', '.join(names)})\n"
            )
    return await _previous_apply(db)


previous.apply_schema = apply_schema
