"""A big decision says it's working and can't be sent twice. Port of
cloudflare/test/review-busy.test.ts (the query counting there is the
Cloudflare edition's concern: each D1 query is a round trip)."""

import re
from pathlib import Path

from server.app import approvals, content, routes

from .web import signed_in, who

CF = Path(__file__).resolve().parents[3] / "cloudflare" / "src" / "routes.ts"


async def test_says_its_working(db, http):
    ids = [(await content.create_item(db, who, "card", {"name": f"C{i}", "description": "x", "visibility": "public"}, None))["id"] for i in range(30)]  # fmt: skip
    r = await approvals.request(db, who, ids, "")
    page = (await http.get(f"/review/{r['id']}", cookies=await signed_in(db))).text
    assert (
        'data-busy="Publishing 30 changes… This can take a few seconds; keep this page open."'
        in page
    )
    assert 'data-busy="Saving your choices…"' in page
    assert "A big decision can take seconds" in page


def test_the_script_is_the_cloudflare_editions():
    cf = re.search(r"export const BUSY_JS = `(.*?)`;", CF.read_text(encoding="utf-8"), re.S).group(
        1
    )
    assert routes.BUSY_JS == cf
