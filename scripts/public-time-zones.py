#!/usr/bin/env python3
"""Build shared finite clock rules from installed IANA TZif files (no sampling)."""
import json
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import _common, _tzpath, available_timezones

START = int(datetime(2000, 1, 1, tzinfo=UTC).timestamp())
END = int(datetime(2038, 1, 1, tzinfo=UTC).timestamp())
root = Path(__file__).resolve().parents[1]
names, rules, indexes = {}, [], {}
for name in sorted(available_timezones()):
    if name in ('localtime','posixrules'):
        continue
    path = _tzpath.find_tzfile(name)
    if not path:
        continue
    with open(path, 'rb') as source:
        ids, transitions, offsets, dst, abbr, tail = _common.load_data(source)
    # Explicit transitions are authoritative only through the file's horizon.
    # A fixed POSIX tail has no further transitions; recurring tails do.
    end = min(END, transitions[-1] + 1) if tail and b',' in tail else END
    if end <= START:
        continue
    initial = next((offsets[i] for t, i in reversed(list(zip(transitions, ids))) if t <= START), offsets[0])
    changes = [[t, offsets[i]] for t, i in zip(transitions, ids) if START < t < end]
    rule = [end, initial, changes]
    key = json.dumps(rule, separators=(',', ':'))
    if key not in indexes:
        indexes[key] = len(rules)
        rules.append(rule)
    names[name] = indexes[key]
version = next((Path(d, '+VERSION').read_text().strip() for d in _tzpath.TZPATH if Path(d, '+VERSION').exists()), 'unknown')
if version == 'unknown':
    raise SystemExit('A source tzdb +VERSION is required')
payload=json.dumps(dict(version=version,start=START,zones=names,rules=[json.dumps(r,separators=(',',':')) for r in rules]),separators=(',',':'))
# The bundler imports one inert string; even the zone index is lazy.
(root/'server/server/spec/public-time-zones.json').write_text(json.dumps(payload,separators=(',',':'))+'\n')
