"""PERF-4 paired gate, representation, race and local-store acceptance."""
import asyncio
import json
from dataclasses import replace
from pathlib import Path
import pytest
from server.app import content, approvals, site, public_read, public_responses as cache, public_artifacts, agent_traffic
from .conftest import TABLES
from server.spec.theme import THEMES as THEMES_DIR
ORIGIN='https://site.example'

@pytest.fixture(autouse=True)
async def clean(db,app):
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    agent_traffic.reset(db)
    app.settings=replace(app.settings,site_url=ORIGIN,public_responses=True)

async def publish(db,item):
    await approvals.publish_now(db,[dict(id=item['id'],version=item['version'])],'',ORIGIN)

async def fixture(db):
    one=await content.create_item(db,'assistant:test','site',dict(title='Response cache',theme='personal-homepage',archive=dict(enabled=True,title='Pages')),None)
    await publish(db,one)
    entry=await content.create_item(db,'assistant:test','entry',dict(title='Entry',date='2026-10-17',body='Public body.'),None)
    await publish(db,entry)
    return one,entry

async def warm(http,app,path='/',**kwargs):
    response=await http.get(path,**kwargs)
    await app._response_store.drain()
    return response

async def test_perf4_all_looks(db,http,app,monkeypatch):
    one,_=await fixture(db)
    directories=[directory for directory in sorted(THEMES_DIR.iterdir()) if (directory/'template.json').is_file()]
    assert len(directories)==12
    for directory in directories:
        one=await content.update_item(db,'assistant:test','site',one['version'],{'theme':directory.name})
        await publish(db,one)
        app.settings=replace(app.settings,public_responses=False)
        off=await http.get('/')
        assert off.status_code==200
        app.settings=replace(app.settings,public_responses=True)
        fill=await warm(http,app)
        assert fill.content==off.content and dict(fill.headers)==dict(off.headers)
        async def forbidden(*args,**kwargs):
            raise AssertionError('Built-in HIT rendered')
        with monkeypatch.context() as patch:
            patch.setattr(site,'live_view',forbidden)
            hit=await http.get('/')
        assert hit.content==off.content and dict(hit.headers)==dict(off.headers)

async def test_perf4_hit_identity(db,http,app,monkeypatch):
    await fixture(db)
    first=await warm(http,app)
    assert len(app._response_store.rows)==1
    async def forbidden(*args,**kwargs):
        raise AssertionError('HIT rendered or entered artifacts/accounting')
    monkeypatch.setattr(site,'live_view',forbidden)
    monkeypatch.setattr(public_artifacts,'respond',forbidden)
    monkeypatch.setattr(agent_traffic,'observe',forbidden)
    hit=await http.get('/',headers={'Origin':'https://other.example'})
    assert hit.content==first.content and dict(hit.headers)==dict(first.headers)
    assert hit.headers['cache-control']=='public, no-cache, must-revalidate, no-transform'
    assert 'age' not in hit.headers
    head=await http.head('/')
    assert head.content==b'' and dict(head.headers)==dict(first.headers)
    def no_match(*args):
        raise AssertionError('304 touched cache')
    monkeypatch.setattr(app._response_store,'match',no_match)
    assert (await http.get('/',headers={'If-None-Match':first.headers['etag']})).status_code==304

async def test_perf4_gate_before_cache(db,http,app,monkeypatch):
    one,_=await fixture(db)
    await warm(http,app)
    calls=[]
    old=app._response_store.match
    monkeypatch.setattr(app._response_store,'match',lambda *args:(calls.append(args),old(*args))[1])
    for headers in [{'Authorization':''},{'Authorization':'Bearer invalid'},{'Cookie':'__Host-sk_owner='},{'Cookie':'__Host-sk_reader=expired'},{'Range':'bytes=0-3'}]:
        await http.get('/',headers=headers)
    app.settings=replace(app.settings,site_url='https://different.example')
    await http.get('/')
    assert not calls
    app.settings=replace(app.settings,site_url=ORIGIN)
    await publish(db,await content.update_item(db,'assistant:test','site',one['version'],{'private':True}))
    assert (await http.get('/')).status_code==404 and not calls

async def test_perf4_key_identity(db,http,app,monkeypatch):
    await fixture(db)
    direct=await warm(http,app,'/index.md')
    assert 'vary' not in direct.headers
    async def forbidden(*args,**kwargs):
        raise AssertionError('Markdown HIT rendered')
    monkeypatch.setattr(site,'live_view',forbidden)
    hit=await http.get('/',headers={'Accept':'text/markdown'})
    assert hit.content==direct.content and hit.headers['vary']=='Accept'
    assert len(app._response_store.rows)==1
    for row in json.loads((Path(__file__).parents[3]/'spec/fixtures/public-response-keys.json').read_text()):
        assert cache.key(row['origin'],row['release'],row['choice'],row['tag'])==row['key']

async def test_perf4_hit_race(db,http,app,monkeypatch):
    one,_=await fixture(db)
    await warm(http,app)
    original=cache.current
    async def changed(*args):
        await publish(db,await content.update_item(db,'assistant:test','site',one['version'],{'private':True}))
        return await original(*args)
    monkeypatch.setattr(cache,'current',changed)
    hit=await http.get('/')
    assert hit.status_code==404 and b'Public body.' not in hit.content

async def test_perf4_previous_runtime(db,http,app):
    _,entry=await fixture(db)
    await warm(http,app)
    old=set(app._response_store.rows)
    await db.execute("UPDATE live SET data=jsonb_set(data::jsonb,'{title}','\"Changed by previous runtime\"'::jsonb)::text,version=version+1 WHERE item_id=$1",entry['id'])
    answer=await warm(http,app)
    assert b'Changed by previous runtime' in answer.content
    assert set(app._response_store.rows)-old

async def test_perf4_put_race(db,http,app,monkeypatch):
    one,_=await fixture(db)
    original=cache.current
    async def changed(*args):
        await publish(db,await content.update_item(db,'assistant:test','site',one['version'],{'private':True}))
        return await original(*args)
    monkeypatch.setattr(cache,'current',changed)
    await warm(http,app)
    assert not app._response_store.rows
    assert (await http.get('/')).status_code==404

async def test_perf4_storage_limits(db,http,app,monkeypatch):
    await fixture(db)
    first=await warm(http,app)
    for damage in ['body','expired','headers']:
        row=next(iter(app._response_store.rows.values()))
        if damage=='body':row['body']=b'corrupt'
        elif damage=='expired':row['metadata'][3]=0
        else:row['headers']['set-cookie']='private=1'
        calls=[];original=site.live_view
        async def record(*args,**kwargs):
            calls.append(True)
            return await original(*args,**kwargs)
        with monkeypatch.context() as patch:
            patch.setattr(site,'live_view',record)
            assert (await warm(http,app)).content==first.content and calls
    def offline(*args):
        raise RuntimeError('store offline')
    monkeypatch.setattr(app._response_store,'match',offline)
    assert (await warm(http,app)).content==first.content
    bounded=cache.Store()
    for i in range(150):bounded.put(str(i),dict(body=b'x'*cache.MAX_BODY,metadata=[],headers={}))
    assert len(bounded.rows)<=128 and bounded.size<=4*1024*1024
    other=cache.Store();assert other.match('149') is None
    await bounded.close();assert bounded.size==0 and not bounded.rows
    started=asyncio.Event();release=asyncio.Event()
    async def paused():started.set();await release.wait()
    assert other.schedule(paused) and other.schedule(paused) and not other.schedule(paused)
    await started.wait();release.set();await other.drain();await other.close()

async def test_perf4_counts(db,http,app,monkeypatch):
    await fixture(db)
    calls=[]
    async def observe(*args,**kwargs):calls.append(True)
    monkeypatch.setattr(agent_traffic,'observe',observe)
    app.settings=replace(app.settings,public_artifacts=True)
    await warm(http,app);await asyncio.sleep(0)
    assert len(calls)==1
    calls.clear();await http.get('/');await asyncio.sleep(0)
    assert not calls
    app.settings=replace(app.settings,public_responses=False)
    await http.get('/');await asyncio.sleep(0)
    assert len(calls)==1 and 'response-cache hits' in agent_traffic.CLASSIFICATION['coverage']

async def test_perf4_storage_clock(db,http,app,monkeypatch):
    await fixture(db)
    first=await warm(http,app)
    row=next(iter(app._response_store.rows.values()))
    captured=dict(body=row['body'],metadata=list(row['metadata']),headers=dict(row['headers']))
    monkeypatch.setattr(cache.time,'time',lambda:captured['metadata'][3]/1000)
    calls=[];original=site.live_view
    async def record(*args,**kwargs):
        calls.append(True)
        return await original(*args,**kwargs)
    monkeypatch.setattr(site,'live_view',record)
    assert (await warm(http,app)).content==first.content and calls
    calls.clear();address=next(iter(app._response_store.rows));app._response_store.rows[address]=captured
    monkeypatch.setattr(cache.time,'time',lambda:(captured['metadata'][2]-1)/1000)
    assert (await warm(http,app)).content==first.content and calls

async def test_perf4_app_lifecycle_partition(db,http,app,monkeypatch):
    await fixture(db)
    await warm(http,app)
    old=app._response_store
    class ReplacementPool:
        def __getattr__(self,name):return getattr(db,name)
    app._pool=ReplacementPool()
    calls=[];original=site.live_view
    async def record(*args,**kwargs):
        calls.append(True)
        return await original(*args,**kwargs)
    monkeypatch.setattr(site,'live_view',record)
    await warm(http,app)
    assert calls and app._response_store is not old and old.closed and not old.rows
    app._pool=db

def test_perf4_exact_operator_flag(monkeypatch):
    from server.app.settings import Settings
    for value in ['', '0','true','yes','01']:
        monkeypatch.setenv('PORCHSITE_PUBLIC_RESPONSES',value)
        assert not Settings.from_env().public_responses
    monkeypatch.setenv('PORCHSITE_PUBLIC_RESPONSES','1')
    assert Settings.from_env().public_responses

async def test_perf4_synthetic_key(db,http,app):
    await fixture(db)
    await warm(http,app)
    address=next(iter(app._response_store.rows))
    response=await http.get(address)
    assert response.status_code==404 and b'Public body.' not in response.content
    bounded=cache.Store()
    for i in range(200):bounded.put(str(i),dict(body=b'x',metadata=[],headers={}))
    assert len(bounded.rows)==128 and bounded.size==128
    await bounded.close()

async def test_perf4_hit_race_unpublish(db,http,app,monkeypatch):
    _,entry=await fixture(db)
    f=await public_read.facts(db)
    page=next(x['page'] for x in f['entries'] if x['id']==entry['id'])
    await warm(http,app,page)
    original=cache.current
    async def removed(*args):
        await db.execute('DELETE FROM live WHERE item_id=$1',entry['id'])
        return await original(*args)
    monkeypatch.setattr(cache,'current',removed)
    answer=await http.get(page)
    assert answer.status_code==404 and b'Public body.' not in answer.content
