"""Shared clock boundaries checked against independently rendered producer output."""
import json
from datetime import UTC, datetime
from pathlib import Path
import pytest
from server.app.content import validate
from server.app import public_read, public_time
from server.spec.blocks import hours_view,notice_view,event_view
from .test_agent_map import request
FIXTURE=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/public-time.json').read_text())
C=dict(base='/',query='',type='text/html; charset=utf-8',kind='html',direct=False)
def ms(value):
    return datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()*1000

def facts(x=None):
    x=x or {}
    site=validate('site',dict(theme='local-business',timezone=x.get('zone','UTC'),**{k:x[k] for k in ('hours','notice') if k in x}))
    return dict(site=site,entries=[dict(id='event',slug='event',stream='journal',streamId='journal',page='/journal/event/',external='',endpoint=x['endpoint'],tags=[])] if x.get('endpoint') else [],rows=[],hasSite=True,themed=True,disabled=False,private=False)

def output(f,at):
    s=f['site'];d=datetime.fromtimestamp(at/1000,UTC)
    return [hours_view(s.get('hours'),s['timezone'],d),notice_view(s.get('notice'),s['timezone'],d),[event_view(dict(start=e['endpoint'],end=''),s['timezone'],d)['is_past'] for e in f['entries']]]

@pytest.mark.parametrize('x',FIXTURE['cases'],ids=lambda x:x['name'])
def test_af_time_boundaries(x):
    f=facts(x);before=ms(x['before']);boundary=ms(x['boundary']);p=public_time.plan(f,C,before)
    assert p['kind']=='bounded' and p['next_change']==boundary
    assert public_time.valid(p,boundary-1) and not public_time.valid(p,boundary)
    assert output(f,boundary-1)==output(f,before) and output(f,boundary)!=output(f,before)
    assert public_time.plan(f,C,boundary)['state']!=p['state']
    if x['name']=='hours_exception_horizon':
        assert len(p['state'][0]['exceptions'])==0 and len(public_time.plan(f,C,boundary)['state'][0]['exceptions'])==1
    if x['name']=='hours_next_open_lookahead':
        assert p['state'][0]['status']=='Closed now' and 'opens' in public_time.plan(f,C,boundary)['state'][0]['status']
    for t in range(int(before),int(boundary),37000):
        assert output(f,t)==output(f,before)

def test_af_time_static_sparse():
    f=facts();now=ms('2026-10-19T08:00Z');req=request('/')
    assert public_time.plan(f,C,now)['kind']=='static'
    assert public_read.tag(f,req,C,'test',now)==public_read.tag(f,req,C,'test',now+7200000)
    timed=facts(FIXTURE['cases'][0])
    for kind in ('map','feed','plain','xml'):
        assert public_time.plan(timed,{**C,'kind':kind},now)['kind']=='static'
    assert public_time.plan(timed,{**C,'base':'/archive/'},now)['kind']=='static'
    assert public_time.plan({**timed,'themed':False},C,now)['kind']=='static'

def test_af_time_unknown_and_rollback():
    f=facts(FIXTURE['cases'][0]);now=ms('2026-10-19T08:00Z');f['site']['timezone']='No/Such_Zone'
    assert public_time.plan(f,C,now)['kind']=='unknown'
    assert public_read.tag(f,request('/'),C,'test',now) is None
    f['site']['timezone']='UTC'
    assert public_time.plan(f,C,ms('2200-01-01T00:00Z'))['kind']=='unknown'
    p=public_time.plan(f,C,now)
    assert not public_time.valid(p,now-1)
    reused=public_time.plan(f,C,now+1000)
    assert reused['at']==now+1000 and not public_time.valid(reused,now+999)
    assert public_time.plan(f,C,now-1)['at']==now-1

def test_af_time_projection_scope():
    f=facts(dict(endpoint='2026-10-19T10:00'));now=ms('2026-10-19T09:00Z')
    assert public_time.plan(f,{**C,'base':'/journal/other/'},now)['kind']=='static'
    f['site']['notice']=dict(text='Date bound',until='2026-10-19')
    assert public_time.plan(f,{**C,'base':'/journal/'},now)['kind']=='bounded'

def test_af_time_complete_registry():
    from server.spec.site import view
    from server.spec import theme
    for x in FIXTURE['cases']:
        f=facts(x);start=ms(x['before'])-7200000
        item=validate('entry',dict(title='Time-bound entry',date='2026-10-18',**(dict(event=dict(start=x['endpoint'])) if x.get('endpoint') else {})))
        for folder in sorted(theme.THEMES.iterdir()):
            if not folder.is_dir():
                continue
            name=folder.name
            v=view({**f['site'],'theme':name},[dict(id='event',kind='entry',slug='event',data=item)])
            previous=None
            for at in range(int(start),int(ms(x['boundary'])+7200000)+1,17*60000):
                v.now=datetime.fromtimestamp(at/1000,UTC)
                state=public_time.stable(public_time.plan(f,C,at)['state'])
                body=theme.render(name,'home',theme.home_view(v,'test','https://site.example'))
                if previous and state==previous[0]:
                    assert body==previous[1],(x['name'],name,at)
                previous=(state,body)


def test_af_time_naive_clock_keeps_existing_utc_convention():
    from server.spec.blocks import local_now
    assert local_now(datetime(2026,10,19,8), 'America/New_York')==local_now(datetime(2026,10,19,8,tzinfo=UTC), 'America/New_York')

def test_af_time_lazy_artifact(monkeypatch):
    from unittest.mock import Mock
    from server.spec import public_time_clock as clock
    f=facts();now=ms('2026-10-19T08:00Z')
    unread=Mock(side_effect=AssertionError('quiet site must not read zone payload'))
    monkeypatch.setattr(clock,'clock_data',unread)
    assert public_time.plan(f,C,now)['kind']=='static'
    d=datetime.fromtimestamp(now/1000,UTC)
    hours_view(None,'UTC',d);notice_view(None,'UTC',d);event_view(None,'UTC',d)
    unread.assert_not_called()
    assert isinstance(json.loads(Path(clock.__file__).with_name('public-time-zones.json').read_text()),str)
