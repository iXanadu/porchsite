"""The approval preview covers every page, not just the home page, with its
links kept inside the preview. Port of cloudflare/test/preview.test.ts
("review preview of new pages")."""

import re

from server.app import approvals, content

from .web import signed_in, who


async def test_shows_a_new_entrys_own_page_with_links_kept_inside_the_preview(db, http):
    cookies = await signed_in(db)
    en = await content.create_item(db, who, "entry", {"title": "The photo album", "date": "2026-10-11", "body": "Pictures from the weekend."}, None)  # fmt: skip
    r = await approvals.request(db, who, [en["id"]], "")
    home = (await http.get(f"/review/{r['id']}/preview", cookies=cookies)).text
    link = re.search(r'href="(/review/[^"]+/preview/[^"]*photo-album[^"]*)"', home)
    assert link
    page = await http.get(link.group(1), cookies=cookies)
    assert page.status_code == 200
    assert (
        "Pictures from the weekend." in page.text and "Preview: nothing is live yet." in page.text
    )
    assert not re.search(r'href="/(?!review/|static/|media/|/)', page.text)
    assert (await http.get(link.group(1))).status_code == 303
