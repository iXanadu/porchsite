"""Request-owned event display components preserve the uncached result."""
from copy import deepcopy
from datetime import UTC, datetime
from unittest.mock import patch

from server.spec import blocks

EVENT = {
    "start": "2027-01-14T18:00", "end": "2027-01-14T20:30",
    "place": {"name": "<Hall>", "address": "Street", "map_link": "https://example.com/map"},
    "rsvp": {"label": "RSVP", "link": "https://example.com/rsvp", "deadline": "2027-01-10"},
    "schedule": [{"time": t, "title": "Start", "note": ""} for t in ["18:00", "18:15", "19:15", "20:15"]],
    "status": "on",
}


def test_components_are_reused_within_one_render_only():
    now = datetime(2026, 10, 18, 12, tzinfo=UTC)
    expected = blocks.event_view(EVENT, "America/Chicago", now)
    with patch.object(blocks, "long_day", wraps=blocks.long_day) as long, patch.object(blocks, "short_day", wraps=blocks.short_day) as short, patch.object(blocks, "clock", wraps=blocks.clock) as clock, patch.object(blocks, "_zone_name", wraps=blocks._zone_name) as zone, patch.object(blocks, "local_now", wraps=blocks.local_now) as local:
        memo = blocks.EventMemo()
        for _ in range(504):
            assert blocks.event_view(EVENT, "America/Chicago", now, memo=memo) == expected
        assert [x.call_count for x in [long, short, clock, zone, local]] == [2, 1, 5, 1, 1]
        blocks.event_view(EVENT, "America/Chicago", now, memo=blocks.EventMemo())
        assert [x.call_count for x in [long, short, clock, zone, local]] == [4, 2, 10, 2, 2]


def test_exact_inputs_preserve_dst_fields_and_schedule_independence():
    memo = blocks.EventMemo()
    for tz in ["UTC", "America/Chicago", "Europe/London", "Asia/Kolkata"]:
        for day in ["2026-03-07", "2026-03-09", "2026-10-24", "2026-10-26"]:
            for reference in ["2026-03-08T07:59:00+00:00", "2026-03-08T08:01:00+00:00", "2026-11-01T07:00:00+00:00"]:
                now = datetime.fromisoformat(reference)
                event = deepcopy(EVENT)
                event.update(start=day + "T18:00", end=day + "T20:30")
                event["rsvp"]["deadline"] = day
                assert blocks.event_view(event, tz, now, memo=memo) == blocks.event_view(event, tz, now)
    now = datetime(2026, 10, 18, 12, tzinfo=UTC)
    for changes in [{}, {"end": "2027-01-16T09:00", "status": "changed"}, {"end": "", "status": "cancelled", "schedule": []}, {"rsvp": None, "place": None}]:
        event = {**EVENT, **changes}
        words = {**blocks.BLOCK_STRINGS, "rsvp_by": "By then", "cancelled": "Off", "changed": "New time"}
        assert blocks.event_view(event, "Europe/London", now, words, memo) == blocks.event_view(event, "Europe/London", now, words)
    one = blocks.event_view(EVENT, "UTC", now, memo=memo)
    two = blocks.event_view(EVENT, "UTC", now, memo=memo)
    assert one["schedule"] is not two["schedule"]
    assert one["schedule"][0] is not two["schedule"][0]
    assert one["place_name"] == "<Hall>"
    assert blocks.event_view(None, "Invalid/Zone", now, memo=memo) == {"has": False}
    assert not blocks.event_view(EVENT, "UTC", datetime(2027, 1, 14, 19), memo=memo)["is_past"]
    assert blocks.event_view(EVENT, "UTC", datetime(2027, 1, 14, 21), memo=memo)["is_past"]
