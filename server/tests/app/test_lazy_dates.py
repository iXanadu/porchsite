from unittest.mock import Mock
import pytest
from server.spec import theme as views
from server.spec.date_memo import date_memo
from server.app.theme import render
from .test_lazy_bodies import state, theme, POLICY

@pytest.mark.parametrize('headings',[False,True])
def test_perf5_lazy_dates(monkeypatch,headings):
    short=Mock(wraps=views.short_date);long=Mock(wraps=views.long_date)
    monkeypatch.setattr(views,'short_date',short);monkeypatch.setattr(views,'long_date',long)
    v=state(200);home=views.home_view(v,'1',POLICY['origin'])
    render(theme('{{#sections}}{{#all}}{{summary}}{{/all}}{{/sections}}',headings),'home',home,POLICY)
    stream=next(s for s in v.site['streams'] if s['id']==v.entries[0]['stream'])
    render(theme('{{#entries}}{{summary}}{{/entries}}',headings),'archive',views.archive_view(v,stream['path'] or stream['id'],'1',POLICY['origin']),POLICY)
    assert short.call_count==long.call_count==0
    t=theme('{{#sections}}{{#all}}{{date_short}} {{date_long}} {{date_short}}{{/all}}{{/sections}}',headings)
    body=render(t,'home',home,POLICY);assert body
    assert short.call_count==long.call_count==1
    render({**t,'manifest':{}},'home',home,POLICY);assert short.call_count==long.call_count==1
    render(t,'home',views.home_view(v,'1',POLICY['origin']),POLICY);assert short.call_count==long.call_count==2

def test_perf5_date_memo_key():
    memo=date_memo();read=Mock(return_value='value')
    assert memo(123,{'month':'short','day':'numeric'},read)=='value'
    assert memo(123,{'day':'numeric','month':'short'},read)=='value'
    assert read.call_count==1
    memo(123,{'month':'short','day':'numeric'},read,zone='America/Chicago')
    memo(123,{'hour':'numeric','hourCycle':'h23'},read)
    memo(123,{'hour':'numeric','hourCycle':'h11'},read)
    memo(124,{'month':'short','day':'numeric'},read)
    assert read.call_count==5
    date_memo()(123,{'month':'short','day':'numeric'},read);assert read.call_count==6
