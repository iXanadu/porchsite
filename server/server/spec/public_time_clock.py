"""Finite IANA rules shared by renderer and proof, never host-offset sampling."""
import json
from functools import lru_cache
from datetime import UTC, datetime
from pathlib import Path
DATA=json.loads(Path(__file__).with_name('public-time-zones.json').read_text())

@lru_cache(maxsize=8)
def decoded(i):
    return json.loads(DATA['rules'][i])

def rules(zone,now):
    i=DATA['zones'].get(zone)
    r=decoded(i) if i is not None else None
    return r if r and DATA['start']*1000<=now<r[0]*1000 else None

def offset(r,now):
    value=r[1]
    for at,n in r[2]:
        if at*1000>now:
            break
        value=n
    return value

def wall(now,zone):
    r=rules(zone,now)
    if r is None:
        return None
    d=datetime.fromtimestamp((now+offset(r,now)*1000)/1000,UTC)
    return dict(date=d.strftime('%Y-%m-%d'),time=d.strftime('%H:%M'),day=['mon','tue','wed','thu','fri','sat','sun'][d.weekday()])

def occurrences(stamp,zone,now):
    r=rules(zone,now)
    if r is None:
        return []
    local=datetime.fromisoformat(stamp).replace(tzinfo=UTC).timestamp()*1000
    return [local-n*1000 for n in sorted(set([r[1]]+[x[1] for x in r[2]])) if rules(zone,local-n*1000) is not None and offset(r,local-n*1000)==n]
