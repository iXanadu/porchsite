"""Renderer clock registry; plans never replace current authorization/data facts."""
import json
import time
from datetime import UTC, datetime, timedelta
from server.spec.blocks import hours_view, notice_view
from server.spec.public_time_clock import rules, wall, occurrences
REGISTRY=('hours','notice','event')
CACHE={}

def stable(value):
    return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'))

def shift(date,days):
    return (datetime.fromisoformat(date)+timedelta(days=days)).date().isoformat()

def plan(f,c,now=None,cacheable=True):
    now=time.time()*1000 if now is None else now
    empty=dict(kind='static',state=[],next_change=None,at=now)
    if not f['themed'] or c['base']=='/archive/' or c['kind'] not in ('html','markdown'):
        return empty
    s=f['site'];zone=str(s.get('timezone') or 'UTC')
    hours=s.get('hours') if (s.get('hours') or {}).get('weekly') else None
    notice=s.get('notice') if (s.get('notice') or {}).get('text') and s['notice'].get('until') else None
    selected=next((e for e in f['entries'] if e['page']==c['base']),None)
    stream=next((x for x in s['streams'] if c['base']==f"/{x.get('path') or x['id']}/" or c['base'].startswith(f"/{x.get('path') or x['id']}/tags/")),None)
    tag=c['base'].split('/tags/',1)[1].strip('/') if '/tags/' in c['base'] else None
    sections={ident for k in s['sections'] for ident in ([x['id'] for x in s['streams'] if x['id'] not in s['sections']] if k=='entries' else [k])}
    events=[[e['id'],e['endpoint']] for e in f['entries'] if e['endpoint'] and (e['id']==selected['id'] if selected else e['streamId']==stream['id'] and (not tag or tag in e['tags']) if stream else c['base']=='/' and e['streamId'] in sections)]
    if not hours and not notice and not events:
        return empty
    unknown=dict(kind='unknown',state=None,next_change=None,at=now)
    r=rules(zone,now);local=wall(now,zone)
    if r is None or local is None:
        return unknown
    key=stable([s['theme'],[r for r in f['rows'] if r[0]=='theme'],zone,hours,notice,events,c['base'],c['kind']]);cached=CACHE.get(key) if cacheable else None
    if cached and now>=cached['at'] and cached['next_change'] is not None and now<cached['next_change']:
        return {**cached,'at':now}
    try:
        def state_at(at):
            n=wall(at,zone)
            if n is None:
                raise ValueError('unsupported clock')
            d=datetime.fromtimestamp(at/1000,UTC)
            return [hours_view(hours,zone,d) if hours else None,notice_view(notice,zone,d) if notice else None,[[ident,end<n['date']+'T'+n['time']] for ident,end in events]]
        state=state_at(now);encoded=stable(state);candidates={r[0]*1000}
        def add(stamp):
            candidates.update(at for at in occurrences(stamp,zone,now) if at>now)
        if hours:
            for days in (0,1,2):
                d=shift(local['date'],days)
                if days:
                    add(d+'T00:00')
                for row in hours['weekly']+(hours.get('exceptions') or []):
                    for name in ('open','close'):
                        if row.get(name):
                            add(d+'T'+row[name])
        if notice:
            add(shift(notice['until'],1)+'T00:00')
        for ident,end in events:
            add((datetime.fromisoformat(end)+timedelta(minutes=1)).isoformat(timespec='minutes'))
        candidates.update(at*1000 for at,_ in r[2] if at*1000>now)
        next_change=r[0]*1000
        for at in sorted(candidates):
            if at>=next_change:
                break
            if stable(state_at(at))!=encoded:
                next_change=at;break
        result=dict(kind='bounded',state=state,next_change=next_change,at=now)
        if cacheable and len(CACHE)>=32:
            del CACHE[next(iter(CACHE))]
        if cacheable: CACHE[key]=result
        return result
    except (ValueError,TypeError,KeyError,OverflowError):
        return unknown

def valid(p,now=None):
    now=time.time()*1000 if now is None else now
    return p['kind']!='unknown' and now>=p['at'] and (p['next_change'] is None or now<p['next_change'])
