"""Same-day entries and notes: the one created later comes first (SPEC
Streams). Port of cloudflare/test/order.test.ts."""

from server.spec.site import view


def entry(id, date, created):
    return {"id": id, "kind": "entry", "slug": id, "data": {"title": id, "date": date, "stream": "journal", "tags": []}, "created": created}  # fmt: skip


def note(id, date, created):
    return {"id": id, "kind": "note", "slug": None, "data": {"text": id, "date": date}, "created": created}  # fmt: skip


def test_puts_the_later_created_of_same_day_items_first_whatever_the_row_order():
    rows = [
        entry("a", "2026-10-01", "2026-10-01T09:00:00Z"),
        entry("b", "2026-10-02", "2026-10-02T08:00:00Z"),
        entry("c", "2026-10-02", "2026-10-02T10:00:00Z"),
        note("n1", "2026-10-02", "2026-10-02T07:00:00Z"),
        note("n2", "2026-10-02", "2026-10-02T11:00:00Z"),
    ]
    for r in (rows, rows[::-1]):
        v = view({"streams": [{"id": "journal", "path": ""}]}, r)
        assert [e["id"] for e in v.entries] == ["c", "b", "a"]
        assert [n["id"] for n in v.notes] == ["n2", "n1"]


def test_keeps_the_rows_order_when_there_is_no_creation_time():
    rows = [entry("x", "2026-10-02", ""), entry("y", "2026-10-02", "")]
    v = view({"streams": [{"id": "journal", "path": ""}]}, rows)
    assert [e["id"] for e in v.entries] == ["x", "y"]
