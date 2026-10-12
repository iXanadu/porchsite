"""/review says how many changes nobody has sent for review (SPEC §5).
Port of cloudflare/test/unsent.test.ts."""

import re

from server.app import approvals, content

from .web import signed_in, who


async def test_counts_changes_no_open_request_covers_and_review_says_so(db, http):
    base = await approvals.unsent(db)
    c = await content.create_item(db, who, "card", {"name": "Ledger", "description": "Books.", "visibility": "public"}, None)  # fmt: skip
    assert await approvals.unsent(db) == base + 1
    # An unfinished entry draft doesn't count.
    await content.create_item(db, who, "entry", {"title": "Half", "date": "2026-10-10", "body": "x", "status": "draft"}, None)  # fmt: skip
    assert await approvals.unsent(db) == base + 1
    # Sent: it's waiting, not unsent.
    await approvals.request(db, who, [c["id"]], "")
    assert await approvals.unsent(db) == base
    # Changed again after sending: that newer version isn't sent.
    await content.update_item(db, who, c["id"], c["version"], {"description": "Books, kept."})
    assert await approvals.unsent(db) == base + 1
    page = (await http.get("/review", cookies=await signed_in(db))).text
    assert re.search(
        r'<p class="meta">There (is 1 change|are \d+ changes) not yet sent to you for review\. Nothing goes live until you approve it\.</p>',
        page,
    )
