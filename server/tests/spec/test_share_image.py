"""An archive or tag page's share picture is the cover of its newest entry
that has one (TEMPLATES §3 meta). Port of cloudflare/test/share-image.test.ts."""

from server.app.content import validate
from server.spec import theme
from server.spec.site import view

s = validate("site", {"title": "Kettle", "share_image": "/media/0123456789abcdef0123456789abcdef.jpg", "share_image_alt": "A kettle"})  # fmt: skip


def entry(id, date, data):
    return {"id": id, "kind": "entry", "slug": id, "data": validate("entry", {"title": id, "date": date, "tags": ["tea"], **data})}  # fmt: skip


def test_uses_the_newest_cover_on_archive_and_tag_pages_else_the_sites():
    cover = "/media/fedcba9876543210fedcba9876543210.jpg"
    v = view(
        s,
        [
            entry("old", "2026-10-01", {"cover": "/media/00000000000000000000000000000000.jpg", "cover_alt": "Old"}),
            entry("mid", "2026-10-02", {"cover": cover, "cover_alt": "Mid"}),
            entry("new", "2026-10-03", {"tags": ["coffee"]}),
        ],
    )  # fmt: skip
    arch = theme.archive_view(v, "journal", "1", "https://site.example")
    assert arch["meta"]["image"] == f"https://site.example{cover}"
    tag = theme.archive_view(v, "journal", "1", "https://site.example", "coffee")
    assert tag["meta"]["image"] == "https://site.example/media/0123456789abcdef0123456789abcdef.jpg"
