"""Importing content from a file (SPEC §5): an assistant that can't reach the
site writes one file; the owner uploads it on /review/import; it becomes one
approval request after every item is checked. Port of
cloudflare/test/import.test.ts."""

import base64
import json
import re

from server.app import approvals, content

from .web import signed_in

PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]) + b"IHDR" + (640).to_bytes(4, "big") + (480).to_bytes(4, "big") + bytes(40)  # fmt: skip


def bundle(items, images=None):
    return json.dumps({"porchsite_import": 1, "from": "Dot", "note": "The reunion site.", "items": items, "images": images or {}})  # fmt: skip


async def test_a_file_becomes_one_approval_request_after_every_item_is_checked(db, http):
    cookies = await signed_in(db)
    page = (await http.get("/review/import", cookies=cookies)).text
    csrf = re.search(r'name="csrf" value="([^"]+)"', page).group(1)

    async def upload(text):
        return await http.post("/review/import", data={"csrf": csrf}, files={"file": ("site.json", text.encode(), "application/json")}, cookies=cookies)  # fmt: skip

    good = bundle(
        [
            {"kind": "site", "data": {"title": "Rams '76", "tagline": "Fifty years on"}},
            {"kind": "entry", "data": {"title": "Banquet", "date": "2026-10-09", "body": "![The banquet hall](image:hall.png)", "cover": "image:hall.png", "cover_alt": "The hall"}},
            {"kind": "card", "data": {"name": "Committee", "description": "Who ran it."}},
        ],
        {"hall.png": base64.b64encode(PNG).decode()},
    )  # fmt: skip
    r = await upload(good)
    assert r.status_code == 303
    aid = r.headers["location"].rsplit("/", 1)[1]
    a = await approvals.get(db, aid)
    assert (
        a["requested_by"] == "assistant:Dot"
        and a["note"] == "The reunion site."
        and len(a["items"]) == 3
    )
    entry = await content.get_item(db, a["items"][1]["id"])
    assert re.fullmatch(r"/media/[0-9a-f]{32}\.png", entry["data"]["cover"])
    assert entry["data"]["body"] == f"![The banquet hall]({entry['data']['cover']})"

    before = len(await content.all_items(db))
    bad = await upload(bundle([{"kind": "entry", "data": {"title": "No date"}}, {"kind": "card", "data": {"name": "Fine", "description": "All good."}}]))  # fmt: skip
    assert bad.status_code == 422
    assert "1 item in the file can&#39;t be used as it stands." in bad.text
    assert "<li>Item 1:" in bad.text
    assert len(await content.all_items(db)) == before

    missing = await upload(bundle([{"kind": "entry", "data": {"title": "x", "date": "2026-10-09", "cover": "image:nope.jpg"}}]))  # fmt: skip
    assert "The file names images it doesn" in missing.text and "nope.jpg" in missing.text
    assert "isn" in (await upload('{"items": []}')).text
