import json
from unittest.mock import AsyncMock, Mock
import pytest
from server.app import site, public_read, routes, agent_traffic
from .test_public_read import clear, seed
from .test_agent_map import Count, request

async def test_perf5_public_proof_budget(db,monkeypatch):
    await seed(db);counted=Count(db);load=AsyncMock(wraps=site.live_view);facts=AsyncMock(wraps=public_read.facts)
    monkeypatch.setattr(site,'live_view',load);monkeypatch.setattr(public_read,'facts',facts)
    response=await routes.handle(request('/'),routes.Context(counted,'',None));await agent_traffic.settle(counted)
    assert response.status_code==200 and b'Approved title' in response.body
    assert load.await_count==1 and load.call_args.kwargs['approved']['site_rows'];assert facts.await_count==2
    writes=[q for q in counted.calls if q.lstrip().upper().startswith(('INSERT','UPDATE','DELETE'))]
    assert len(counted.calls)-len(writes)<=5 and len(writes)<=1
    assert all(q.startswith('INSERT INTO agent_traffic_daily') for q in writes)
    assert any('SELECT l.*, i.created_at' in q for q in counted.calls)
    assert not any('SELECT item_id, version, name FROM share_cards' in q or 'SELECT sources, approved FROM site_embed_sources WHERE version' in q for q in counted.calls)

@pytest.mark.parametrize('headers',[{'Authorization':''},{'Authorization':'Bearer invalid'},{'Cookie':'__Host-sk_owner=invalid'},{'Cookie':'__Host-sk_reader=invalid'}])
async def test_perf5_credential_bypass(db,monkeypatch,headers):
    await seed(db);load=AsyncMock(wraps=site.live_view);proof=Mock(wraps=public_read.view_proof)
    monkeypatch.setattr(site,'live_view',load);monkeypatch.setattr(public_read,'view_proof',proof)
    await routes.handle(request('/',headers=headers),routes.Context(db,'',None))
    assert load.await_count and all(c.kwargs.get('approved') is None for c in load.call_args_list);proof.assert_not_called()

async def test_perf5_version_and_raw_match(db):
    await seed(db);proof=public_read.view_proof(await public_read.facts(db))
    await db.execute("UPDATE live SET data=jsonb_set(data::jsonb,'{title}','\"Current same-version title\"'::jsonb)::text WHERE item_id='site'")
    counted=Count(db);view=await site.live_view(counted,approved=proof)
    assert view.site['title']=='Current same-version title'
    assert any('SELECT sources, approved FROM site_embed_sources WHERE version' in q for q in counted.calls)

async def test_perf5_share_version(db):
    item=await seed(db);name='a'*32+'.jpg'
    await db.execute("INSERT INTO share_cards(item_id,version,name,created_at)VALUES($1,2,$2,'2026-10-17')",item['id'],name)
    proof=public_read.view_proof(await public_read.facts(db));assert (await site.live_view(db,approved=proof)).share_cards=={}
    await db.execute('UPDATE share_cards SET version=1')
    proof=public_read.view_proof(await public_read.facts(db));assert (await site.live_view(db,approved=proof)).share_cards=={item['id']:'/media/'+name}

async def test_perf5_extension_race(db,monkeypatch):
    await seed(db);original=public_read.facts;calls=0
    async def reading(db):
        nonlocal calls
        f=await original(db);calls+=1
        if calls==1:
            row=await db.fetchrow('SELECT settings FROM site_stream_settings WHERE version=1');value=json.loads(row['settings']);value['streams'][0]['title']='Fresh approved stream';value['streams'][0]['nav_label']='Fresh approved stream'
            await db.execute('UPDATE site_stream_settings SET settings=$1 WHERE version=1',json.dumps(value))
        return f
    monkeypatch.setattr(public_read,'facts',reading);load=AsyncMock(wraps=site.live_view);monkeypatch.setattr(site,'live_view',load)
    r=await routes.handle(request('/'),routes.Context(db,'',None));assert r.status_code==200 and b'Fresh approved stream' in r.body;assert load.await_count==2
    assert load.call_args_list[0].kwargs['approved']['site_rows']!=load.call_args_list[1].kwargs['approved']['site_rows']

async def test_perf5_private_race(db,monkeypatch):
    await seed(db);original=site.live_view;once=True
    async def reading(*args,**kwargs):
        nonlocal once
        if once:
            once=False
            await db.execute("INSERT INTO site_fields(version,key,value,approved)VALUES(1,'private','true',1) ON CONFLICT(version,key) DO UPDATE SET value='true',approved=1")
            await db.execute('INSERT INTO private_approvals(version)VALUES(1) ON CONFLICT DO NOTHING')
        return await original(*args,**kwargs)
    monkeypatch.setattr(site,'live_view',reading);r=await routes.handle(request('/'),routes.Context(db,'',None))
    assert r.status_code==404 and r.body==b'<!doctype html><meta name="robots" content="noindex"><title></title><a href="/login?next=%2Freview">Sign in</a>' and 'etag' not in r.headers

async def test_perf5_source_rules():
    from server.app.errors import ApiError
    f=dict(rows=[['live','site',['site',None,1,'','',None,None,None,{}]],['streams','site',[{'title':'Injected owner string'},True]]],private=False,hasSite=True,site={})
    # An absent site model takes the normal path; a populated model must still validate the isolated extension.
    f['site']={'title':'Approved title'};f['rows'][0][2][8]={'title':'Approved title'}
    with pytest.raises(ApiError,match='Stored stream settings do not validate'):
        public_read.view_proof(f)
