"""Public read budgets and boundaries, paired with Worker public-read tests."""
from unittest.mock import AsyncMock,Mock
import pytest
from server.app import routes,content,approvals,site,public_read,agent_markdown,agent_traffic,public_artifacts
from .test_agent_map import Count,request
from .conftest import TABLES
ORIGIN='https://site.example'

@pytest.fixture(autouse=True)
async def clear(db):
    agent_traffic.reset(db)
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    await db.execute('UPDATE auth_state SET owner_epoch=0 WHERE id=1')

async def seed(db):
    s=await content.create_item(db,'assistant:test','site',{'title':'Approved title','description':'Approved summary','archive':{'enabled':True}},None)
    item=await content.create_item(db,'assistant:test','entry',{'title':'Entry title','date':'2026-10-17','summary':'Entry summary','body':'Body canary not in metadata'},None)
    await approvals.publish_now(db,[{'id':s['id'],'version':1},{'id':item['id'],'version':1}],'',ORIGIN)
    return item

async def test_perf_conditional_budget(db,monkeypatch):
    await seed(db)
    counted=Count(db)
    cx=routes.Context(counted,'',None)
    first=await routes.handle(request('/'),cx)
    assert first.status_code==200 and first.headers['etag'].startswith('W/"dep1-')
    assert b'"name":"Approved title"' in first.body
    await agent_traffic.settle(counted)
    def refused(*args,**kwargs):
        pytest.fail('matching conditional must not render or parse')
    monkeypatch.setattr(site,'live_view',refused)
    monkeypatch.setattr(agent_markdown,'markdown_document',refused)
    monkeypatch.setattr(public_artifacts,'snapshot',refused)
    monkeypatch.setattr(agent_traffic,'observe',refused)
    for method in ['GET','HEAD']:
        counted.calls.clear()
        hit=await routes.handle(request('/',method,{'If-None-Match':first.headers['etag']}),cx)
        assert hit.status_code==304 and hit.body==b''
        assert len(counted.calls)<=3
        assert all(not sql.lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for sql in counted.calls)
        for key in ['Content-Type','Cache-Control','Content-Signal','ETag','Vary','Link','Content-Security-Policy']:
            assert hit.headers.get(key)==first.headers.get(key),key

async def test_perf_missing_budget(db,monkeypatch):
    await seed(db)
    counted=Count(db)
    cx=routes.Context(counted,'',None)
    def refused(*args,**kwargs):
        pytest.fail('miss must use facts rather than liveView')
    monkeypatch.setattr(site,'live_view',refused)
    for path in ['/wp-admin/install.php','/journal/absent/','/journal/absent/index.md']:
        counted.calls.clear()
        response=await routes.handle(request(path,headers={'If-None-Match':'*'}),cx)
        assert response.status_code==404 and 'etag' not in response.headers
        assert len(counted.calls)<=3

async def test_perf_stamp_changes(db,monkeypatch):
    item=await seed(db)
    cx=routes.Context(db,'',None)
    first=await routes.handle(request('/'),cx)
    await db.execute('UPDATE live SET version=version+1 WHERE item_id=$1',item['id'])
    edited=await routes.handle(request('/',headers={'If-None-Match':first.headers['etag']}),cx)
    assert edited.status_code==200 and edited.headers['etag']!=first.headers['etag']
    now=public_read.time.time()
    monkeypatch.setattr(public_read.time,'time',lambda:now+60)
    timed=await routes.handle(request('/',headers={'If-None-Match':edited.headers['etag']}),cx)
    assert timed.status_code==200 and timed.headers['etag']!=edited.headers['etag']

async def test_perf_one_view_and_metadata(db,monkeypatch):
    await seed(db)
    counted=Count(db)
    load=AsyncMock(wraps=site.live_view)
    monkeypatch.setattr(site,'live_view',load)
    copy=Mock(wraps=agent_markdown.markdown_document)
    monkeypatch.setattr(agent_markdown,'markdown_document',copy)
    response=await routes.handle(request('/archive/'),routes.Context(counted,'',None))
    assert response.status_code==200 and b'application/ld+json' in response.body
    assert load.await_count==1 and copy.call_count==0
    assert sum("f.key = 'private'" in q for q in counted.calls)==1


async def test_perf_route_shapes(db,http):
    item=await seed(db)
    updated=await content.update_item(db,'assistant:test','site',1,{'theme':'personal-homepage'})
    await approvals.publish_now(db,[{'id':'site','version':updated['version']}],'',ORIGIN)
    cases=[('/journal',301),(f"/journal/{item['slug']}",301),(f"/e/{item['slug']}/",301),('/journal/search.json',200),('/archive?sort=stream',301),('/archive?sort=invalid',400)]
    for path,status in cases:
        response=await http.get(path)
        assert response.status_code==status,path


@pytest.mark.parametrize('path',['/','/index.md','/llms.txt'])
async def test_perf_private_during_view(db,monkeypatch,path):
    from server.app.privacy import BLANK
    await seed(db)
    load=site.live_view
    once=True
    calls=0
    async def private(*args,**kwargs):
        nonlocal once,calls
        calls+=1
        if once:
            once=False
            hidden=await content.update_item(db,'assistant:test','site',1,{'private':True})
            await approvals.publish_now(db,[{'id':'site','version':hidden['version']}],'',ORIGIN)
        return await load(*args,**kwargs)
    monkeypatch.setattr(site,'live_view',private)
    response=await routes.handle(request(path,headers={'Authorization':'Bearer invalid','If-None-Match':'*'}),routes.Context(db,'',None))
    assert response.status_code==404 and response.body==BLANK.encode()
    assert 'etag' not in response.headers
    assert calls==1

async def test_perf_conditional_race(db,monkeypatch):
    item=await seed(db)
    path='/journal/'+item['slug']+'/'
    cx=routes.Context(db,'',None)
    warm=await routes.handle(request(path),cx)
    assert warm.status_code==200 and 'etag' in warm.headers
    load=public_read.facts
    calls=0
    async def remove(db):
        nonlocal calls
        calls+=1
        if calls==2:
            gone=await content.remove_item(db,'assistant:test',item['id'],item['version'])
            await approvals.publish_now(db,[{'id':gone['id'],'version':gone['version']}],'',ORIGIN)
        return await load(db)
    monkeypatch.setattr(public_read,'facts',remove)
    response=await routes.handle(request(path,headers={'If-None-Match':warm.headers['etag']}),cx)
    assert response.status_code==404 and 'etag' not in response.headers
