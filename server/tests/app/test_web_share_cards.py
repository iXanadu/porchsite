"""Share cards (SPEC §5): the owner's browser draws each published entry's
card; the site lists what's missing, keeps what's sent, and shares it.
Port of cloudflare/test/share-cards.test.ts, plus the script's bytes."""

import re
from pathlib import Path

from server.app import approvals, content, media, sharecards

from .web import signed_in, who

CF = Path(__file__).resolve().parents[3] / "cloudflare" / "src" / "sharecards.ts"


def jpeg(w, h):
    """Enough of a JPEG for the type and size checks: SOI, then an SOF0."""
    return bytes([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, *([7] * 64)])


async def publish(db, ids):
    req = await approvals.request(db, who, ids, "")
    await approvals.decide(db, req["id"], {i: {"decision": "approve"} for i in ids}, "")


async def test_lists_whats_missing_keeps_what_the_browser_sends_and_shares_it(db, http):
    cookies = await signed_in(db)
    s = await content.create_item(db, who, "site", {"title": "Kettle", "theme": "personal-homepage"}, None)  # fmt: skip
    cover = await media.store(db, jpeg(1600, 900), "image/jpeg", "test")
    en = await content.create_item(db, who, "entry", {"title": "When it looks done", "date": "2026-10-12", "cover": cover, "cover_alt": "A boat"}, None)  # fmt: skip
    await publish(db, [s["id"], en["id"]])

    page = (await http.get("/review", cookies=cookies)).text
    csrf = re.search(r'id="share-cards" hidden data-csrf="([^"]+)"', page).group(1)
    listed = (await http.get("/review/cards.json", cookies=cookies)).json()["cards"]
    assert listed == [{"id": en["id"], "version": 1, "title": "When it looks done", "label": "Updates · site.example", "photo": cover}]  # fmt: skip

    async def send(body, token=csrf, version=1):
        return await http.post(f"/review/cards/{en['id']}?version={version}", content=body, headers={"Content-Type": "image/jpeg", "X-CSRF": token}, cookies=cookies)  # fmt: skip

    assert (await send(jpeg(1200, 630), "nope")).status_code == 403
    assert (await send(jpeg(800, 600))).status_code == 422
    assert (await send(jpeg(1200, 630), csrf, 2)).status_code == 409
    assert (await send(jpeg(1200, 630))).status_code == 204
    assert (await http.get("/review/cards.json", cookies=cookies)).json()["cards"] == []

    name = await db.fetchval("SELECT name FROM share_cards WHERE item_id = $1", en["id"])
    entry_page = (await http.get(f"/journal/{en['slug']}/")).text
    assert f'<meta property="og:image" content="https://site.example/media/{name}">' in entry_page
    assert (await http.get(f"/media/{name}")).status_code == 200

    # A new version of the entry wants a new card.
    en2 = await content.update_item(db, who, en["id"], en["version"], {"title": "When it looks done, it might not be"})  # fmt: skip
    await publish(db, [en2["id"]])
    assert [c["version"] for c in (await http.get("/review/cards.json", cookies=cookies)).json()["cards"]] == [2]  # fmt: skip


def test_the_script_is_the_cloudflare_editions():
    src = CF.read_text(encoding="utf-8")
    body = src[
        src.index("export const CARD_JS = `") + len("export const CARD_JS = `") : src.index(
            "`;\n", src.index("export const CARD_JS")
        )
    ]
    # The template literal's only escapes are doubled backslashes.
    assert sharecards.CARD_JS == body.replace("\\\\", "\\")
