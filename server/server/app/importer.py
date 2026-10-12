"""Importing content from a file (SPEC §5): for an assistant that can't
reach the site at all. It writes one JSON file; the owner uploads it at
/review/import. Every item goes through the same checks an assistant's
drafts do, and the lot becomes one approval request: nothing is public
until the owner approves it. Port of cloudflare/src/importer.ts (the file
format is described there).
"""

import base64
import binascii
import json
import re
from typing import Any

from server.spec.models import KINDS, SITE_ID

from . import approvals, content, media
from .db import Db
from .errors import ApiError

MAX_FILE = 25 * 1024 * 1024
MAX_ITEMS = 200
REF = re.compile(r"image:([A-Za-z0-9._-]{1,80})")


def _decode(b64: str) -> bytes:
    raw = re.sub(r"\s", "", re.sub(r"^data:[^,]*,", "", b64)).replace("-", "+").replace("_", "/")
    return base64.b64decode(raw + "=" * (-len(raw) % 4), validate=True)


def _swap(v: Any, paths: dict[str, str], missing: set[str]) -> Any:
    if isinstance(v, str):

        def one(m: re.Match[str]) -> str:
            p = paths.get(m.group(1))
            if not p:
                missing.add(m.group(1))
            return p or m.group(0)

        return REF.sub(one, v)
    if isinstance(v, list):
        return [_swap(x, paths, missing) for x in v]
    if isinstance(v, dict):
        return {k: _swap(x, paths, missing) for k, x in v.items()}
    return v


async def import_file(db: Db, text: str) -> dict[str, Any]:
    try:
        file = json.loads(text)
    except ValueError:
        raise ApiError(422, "invalid", "That file isn't JSON.") from None
    if (
        not isinstance(file, dict)
        or file.get("porchsite_import") != 1
        or not isinstance(file.get("items"), list)
    ):
        raise ApiError(422, "invalid", 'That isn\'t a Porchsite import file: it needs "porchsite_import": 1 and "items".')  # fmt: skip
    if not file["items"] or len(file["items"]) > MAX_ITEMS:
        raise ApiError(422, "invalid", f"An import has 1 to {MAX_ITEMS} items.")
    actor = f"assistant:{str(file.get('from') or 'import').strip()[:40] or 'import'}"

    # Pictures first: each is checked and stored like any upload.
    paths: dict[str, str] = {}
    for name, b64 in (file.get("images") or {}).items():
        try:
            data = _decode(str(b64))
        except (ValueError, binascii.Error):
            raise ApiError(422, "invalid", f"The image {name} isn't base64.") from None
        type_ = media.sniff(data)
        if not type_:
            raise ApiError(
                422, "not_an_image", f"The image {name} isn't a JPEG, PNG or WebP picture."
            )
        if len(data) > media.MAX_BYTES:
            raise ApiError(413, "too_large", f"The image {name} is over 8 MB.")
        paths[name] = await media.store(db, data, type_, actor)

    # Every item checked before any is saved.
    missing: set[str] = set()
    items = [
        {
            "kind": str((it or {}).get("kind") or ""),
            "data": _swap((it or {}).get("data") or {}, paths, missing),
        }  # fmt: skip
        for it in file["items"]
    ]
    if missing:
        raise ApiError(422, "invalid", f"The file names images it doesn't include: {', '.join(sorted(missing))}.")  # fmt: skip
    site = await db.fetchrow("SELECT version, data FROM items WHERE id = $1", SITE_ID)
    problems = []
    for i, it in enumerate(items):
        try:
            if it["kind"] not in KINDS:
                raise ApiError(422, "invalid", f"kind must be one of: {', '.join(KINDS)}.")
            data = (
                {**json.loads(site["data"]), **it["data"]}
                if it["kind"] == "site" and site
                else it["data"]
            )
            content.validate(it["kind"], data)
        except ApiError as e:
            problems.append({"item": i + 1, "error": e.code, "message": e.message})
    if problems:
        n = len(problems)
        raise ApiError(422, "invalid", "1 item in the file can't be used as it stands." if n == 1 else f"{n} items in the file can't be used as they stand.", {"problems": problems})  # fmt: skip

    ids = []
    for it in items:
        if it["kind"] == "site" and site:
            cur = await content.get_item(db, SITE_ID)
            ids.append((await content.update_item(db, actor, SITE_ID, cur["version"], it["data"], "import"))["id"])  # fmt: skip
        else:
            ids.append((await content.create_item(db, actor, it["kind"], it["data"], None))["id"])
    a = await approvals.request(db, actor, ids, str(file.get("note") or "")[:1000])
    return {"approval": a["id"], "count": len(ids)}
