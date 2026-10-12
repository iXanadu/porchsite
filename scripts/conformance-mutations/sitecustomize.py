"""Deliberately broken server editions, for scripts/conformance-mutations.sh.

Python imports this at start-up when its folder is on PYTHONPATH; with
PORCHSITE_MUTATION set, it breaks one safety rule before the app loads, so
the conformance check can show it notices. Never on PYTHONPATH otherwise.
"""

import os

MUTATION = os.environ.get("PORCHSITE_MUTATION", "")

if MUTATION:
    from server.app import content, media

    if MUTATION == "guard-off":  # S6: secrets get through
        content.check_guard = lambda data: None

    elif MUTATION == "stale-update":  # S3: any version is taken as current
        _update = content.update_item

        async def _stale(db, actor, id, version, patch, *rest, **kw):
            current = await content.get_item(db, id)
            return await _update(db, actor, id, current["version"], patch, *rest, **kw)

        content.update_item = _stale

    elif MUTATION == "no-replay":  # S4: a retried create makes a second item
        _create = content.create_item

        async def _fresh(db, actor, kind, input, idempotency_key, *rest, **kw):
            return await _create(db, actor, kind, input, None, *rest, **kw)

        content.create_item = _fresh

    elif MUTATION == "hotlink":  # S7: outside images kept as links
        async def _keep(db, kind, data, *rest, **kw):
            return data

        media.localize = _keep

    else:
        raise SystemExit(f"unknown PORCHSITE_MUTATION {MUTATION!r}")
