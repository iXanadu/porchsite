"""AF-7 acceptance, paired with native Worker public-artifacts tests."""
import asyncio
from dataclasses import replace
import json
import pytest
from server.app import approvals,content,site,public_artifacts as artifacts,public_read,agent_traffic,content_revision
from server.app.privacy import BLANK,SIGN_IN
from .conftest import TABLES
from .test_private_site import browser_factory as browser_factory
from .softkey import SoftKey

ORIGIN, ACTOR = 'https://site.example','assistant:test'

@pytest.fixture(autouse=True)
async def clear(db,app):
    agent_traffic.reset(db)
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    app.settings=replace(app.settings,site_url=ORIGIN,public_artifacts=True)

async def publish(db,item):
    await approvals.publish_now(db,[{'id':item['id'],'version':item['version']}],'',ORIGIN)

async def fixture(db):
    one=await content.create_item(db,ACTOR,'site',{'title':'Prepared fixture','theme':'personal-homepage','archive':{'enabled':True,'title':'All pages'}},None)
    await publish(db,one)
    entry=await content.create_item(db,ACTOR,'entry',{'title':'First page','date':'2026-10-17','body':'Published body.','tags':['tag']},None)
    await publish(db,entry)
    return one,entry

async def count(db):
    return await db.fetchval('SELECT count(*) FROM public_artifacts')

async def test_af_prebuild_bytes(db,http,app,monkeypatch):
    await fixture(db)
    first=await http.get('/')
    assert await count(db)==1
    app.settings=replace(app.settings,public_artifacts=False)
    live_head=await http.head('/')
    app.settings=replace(app.settings,public_artifacts=True)
    assert live_head.content==b'' and dict(live_head.headers)==dict(first.headers)
    async def forbidden(*args,**kwargs):
        raise AssertionError('warm hit rendered')
    monkeypatch.setattr(site,'live_view',forbidden)
    warm=await http.get('/')
    assert warm.content==first.content
    assert dict(warm.headers)==dict(first.headers)
    conditional=await http.get('/',headers={'If-None-Match':first.headers['etag']})
    assert conditional.status_code==304 and conditional.content==b''
    head=await http.head('/')
    assert head.status_code==200 and head.content==b''
    assert dict(head.headers)==dict(first.headers)

async def test_af_prebuild_negotiation(db,http,monkeypatch):
    await fixture(db)
    direct=await http.get('/index.md')
    assert await count(db)==1 and 'vary' not in direct.headers
    async def forbidden(*args,**kwargs):
        raise AssertionError('copy warm hit rendered')
    with monkeypatch.context() as patch:
        patch.setattr(site,'live_view',forbidden)
        selected=await http.get('/',headers={'Accept':'text/markdown'})
        assert selected.content==direct.content and selected.headers['etag']==direct.headers['etag']
        assert selected.headers['vary']=='Accept' and await count(db)==1
    refused=await http.get('/',headers={'Accept':'text/plain;q=1,text/html;q=0,text/markdown;q=0'})
    assert refused.status_code==406 and await count(db)==1

async def test_af_prebuild_dependency_matrix(db,http):
    one,_=await fixture(db)
    await http.get('/')
    stamp=await artifacts.snapshot(db)
    draft=await content.update_item(db,ACTOR,'site',one['version'],{'title':'Changed title'})
    assert await artifacts.snapshot(db)==stamp and await count(db)==1
    await http.get('/')
    assert await count(db)==1
    await publish(db,draft)
    assert await count(db)==0
    assert 'Changed title' in (await http.get('/')).text
    blocked=await content.update_item(db,ACTOR,'site',draft['version'],{'ai_training_disabled':True})
    await publish(db,blocked)
    assert await count(db)==0
    assert 'ai-train=no' in (await http.get('/')).headers['content-signal']

async def test_af_prebuild_publication_atomic(db,http):
    one,_=await fixture(db)
    await http.get('/')
    draft=await content.update_item(db,ACTOR,'site',one['version'],{'title':'Must not publish'})
    await db.execute("CREATE FUNCTION fail_artifact_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'artifact delete failure'; END $$")
    await db.execute('CREATE TRIGGER fail_artifact_delete BEFORE DELETE ON public_artifacts FOR EACH ROW EXECUTE FUNCTION fail_artifact_delete()')
    try:
        with pytest.raises(Exception):
            await publish(db,draft)
        assert await db.fetchval("SELECT version FROM live WHERE item_id='site'")==one['version']
        assert await count(db)==1
    finally:
        await db.execute('DROP TRIGGER fail_artifact_delete ON public_artifacts; DROP FUNCTION fail_artifact_delete()')

async def test_af_prebuild_gate_first(db,http,monkeypatch):
    one,_=await fixture(db)
    await http.get('/')
    for headers in [{'Authorization':'Bearer fixture'},{'Cookie':'__Host-sk_owner=expired'},{'Cookie':'__Host-sk_reader=revoked'}]:
        response=await http.get('/',headers=headers)
        assert 'no-store' in response.headers['cache-control'] and 'etag' not in response.headers
    assert await count(db)==1
    hidden=await content.update_item(db,ACTOR,'site',one['version'],{'private':True})
    await publish(db,hidden)
    assert await count(db)==0
    async def forbidden(*args,**kwargs):
        raise AssertionError('private request entered public storage path')
    monkeypatch.setattr(artifacts,'respond',forbidden)
    for path in ['/','/index.md','/llms.txt','/missing/index.md']:
        for headers in [{},{'Cookie':'__Host-sk_owner=expired'},{'Authorization':'Bearer fixture'}]:
            response=await http.get(path,headers={**headers,'Accept':'text/markdown','If-None-Match':'*'})
            assert response.status_code==404 and response.content==(BLANK if "Authorization" in headers else SIGN_IN).encode()
            assert 'etag' not in response.headers
    assert await count(db)==0

async def test_af_prebuild_races(db,http,monkeypatch):
    one,_=await fixture(db)
    original=site.live_view
    entered,resume=asyncio.Event(),asyncio.Event()
    once=True
    async def barrier(*args,**kwargs):
        nonlocal once
        view=await original(*args,**kwargs)
        if once:
            once=False
            entered.set()
            await resume.wait()
        return view
    monkeypatch.setattr(site,'live_view',barrier)
    pending=asyncio.create_task(http.get('/'))
    await asyncio.wait_for(entered.wait(),5)
    hidden=await content.update_item(db,ACTOR,'site',one['version'],{'private':True})
    await publish(db,hidden)
    resume.set()
    response=await pending
    assert response.status_code==404 and response.content==SIGN_IN.encode()
    assert await count(db)==0

async def test_af_prebuild_clock(db,http,monkeypatch):
    await fixture(db)
    await http.get('/')
    await db.execute('UPDATE public_artifacts SET valid_until=0')
    original=site.live_view
    calls=0
    async def observed(*args,**kwargs):
        nonlocal calls
        calls+=1
        return await original(*args,**kwargs)
    monkeypatch.setattr(site,'live_view',observed)
    assert (await http.get('/')).status_code==200 and calls>0
    assert await count(db)==1
    assert artifacts.display_boundary(1793512799000)==1793599199000

async def test_af_prebuild_bounded_failure(db,http):
    await fixture(db)
    first=await http.get('/')
    await db.execute('UPDATE public_artifacts SET metadata=$1',json.dumps([['set-cookie','secret=1']]))
    repaired=await http.get('/')
    assert repaired.content==first.content and 'set-cookie' not in repaired.headers
    await db.execute('ALTER TABLE public_artifacts RENAME TO unavailable_artifacts')
    try:
        assert (await http.get('/index.md')).status_code==200
    finally:
        await db.execute('ALTER TABLE unavailable_artifacts RENAME TO public_artifacts')
    assert artifacts.configured_origin('https://user:pass@example.com') is None
    assert artifacts.configured_origin('https://example.com/path') is None

async def test_af_prebuild_unconfigured_origin(db,http,app):
    await fixture(db)
    app.settings=replace(app.settings,site_url='')
    assert (await http.get('/')).status_code==200 and await count(db)==0
    app.settings=replace(app.settings,site_url='https://other.example')
    assert (await http.get('/')).status_code==200 and await count(db)==0


async def test_af_prebuild_accounting(db,http,app):
    from server.app import routes
    await fixture(db)
    cx=routes.Context(db,app.settings.setup_code,app.provider,ORIGIN,app.settings.release,True)
    req=artifacts.request_for(ORIGIN,'/')
    await artifacts.prepare(db,ORIGIN,app.settings.release,lambda r:routes.render_public(r,cx),lambda:routes.public_paths(req,cx))
    assert await count(db)>0
    assert await db.fetchval('SELECT COALESCE(sum(requests),0) FROM agent_traffic_daily')==0
    await http.get('/')
    await agent_traffic.settle(db)
    assert await db.fetchval('SELECT sum(requests) FROM agent_traffic_daily')==1


async def test_af_prebuild_bounded_rows(db,http):
    await fixture(db)
    await http.get('/')
    row=await db.fetchrow('SELECT generation,metadata,valid_until FROM public_artifacts LIMIT 1')
    await db.execute('DELETE FROM public_artifacts')
    await db.executemany('INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size) VALUES($1,$2,$3,$4,$5,$6)',[(f'occupied-{i}',row['generation'],'x',row['metadata'],row['valid_until'],1) for i in range(128)])
    md=await http.get('/index.md')
    assert md.status_code==200 and len(md.content)>30 and await count(db)==128
    await db.execute('UPDATE public_artifacts SET valid_until=0')
    await http.get('/index.md')
    assert await count(db)==1


async def test_af_prebuild_corrupt_body(db,http):
    await fixture(db)
    first=await http.get('/')
    await db.execute("UPDATE public_artifacts SET body='CORRUPTED BODY'")
    assert (await http.get('/')).content==first.content


async def test_af_prebuild_dst_clock(db,http,monkeypatch):
    from datetime import datetime
    one,_=await fixture(db)
    hours=await content.update_item(db,ACTOR,'site',one['version'],{'theme':'local-business','timezone':'America/New_York','hours':{'weekly':[{'day':'sun','open':'01:00','close':'01:30'}]}})
    await publish(db,hours)
    current=datetime.fromisoformat('2026-11-01T05:59:30+00:00')
    original=site.live_view
    async def clocked(*args,**kwargs):
        view=await original(*args,**kwargs)
        view.now=current
        return view
    monkeypatch.setattr(site,'live_view',clocked)
    monkeypatch.setattr(artifacts.time,'time',lambda:current.timestamp())
    before=await http.get('/')
    assert 'Closed now' in before.text and await count(db)==1
    current=datetime.fromisoformat('2026-11-01T06:00:00+00:00')
    after=await http.get('/',headers={'If-None-Match':before.headers['etag']})
    assert after.status_code==200 and 'Open now' in after.text
    assert after.headers['etag']!=before.headers['etag'] and await count(db)==1


async def test_af_prebuild_shared_digest():
    from pathlib import Path
    cases=json.loads((Path(__file__).parents[3]/'spec/fixtures/public-artifacts.json').read_text())
    for c in cases:
        assert artifacts.digest(artifacts.dumps([artifacts.FORMAT,'fixture','https://example.com',artifacts.normalized_state(json.dumps(c['state']))]))==c['sha256']


async def test_af_prebuild_oversized_body(db):
    from starlette.responses import Response
    from server.app.public_http import public_response
    await fixture(db)
    request=artifacts.request_for(ORIGIN,'/guide/large/')
    body='x'*(artifacts.MAX_BODY+1)
    async def render():
        return await public_response(db,request,Response(body,headers={'Content-Type':'text/html; charset=utf-8'}),ORIGIN)
    response=await artifacts.respond(db,request,ORIGIN,'test',render)
    assert response.status_code==200 and response.body.decode()==body and await count(db)==0


async def test_af_prebuild_private_preparation(db,app,monkeypatch):
    from server.app import routes
    one,_=await fixture(db)
    hidden=await content.update_item(db,ACTOR,'site',one['version'],{'private':True})
    await publish(db,hidden)
    async def forbidden(*args,**kwargs):
        raise AssertionError('private prebuild')
    monkeypatch.setattr(site,'live_view',forbidden)
    cx=routes.Context(db,app.settings.setup_code,app.provider,ORIGIN,app.settings.release,True)
    req=artifacts.request_for(ORIGIN,'/')
    await artifacts.prepare(db,ORIGIN,app.settings.release,lambda r:routes.render_public(r,cx),lambda:routes.public_paths(req,cx))
    assert await count(db)==0


async def test_af_prebuild_unpublish_restore_visibility(db,http):
    _,entry=await fixture(db)
    path='/journal/'+entry['slug']+'/'
    for address in [path,'/index.md','/llms.txt']:
        await http.get(address)
    assert await count(db)==3
    gone=await content.remove_item(db,ACTOR,entry['id'],entry['version'])
    assert await count(db)==3
    await publish(db,gone)
    assert await count(db)==0 and (await http.get(path)).status_code==404
    restored=await content.restore(db,ACTOR,gone['id'],gone['version'],entry['data'],False,'Restore published page')
    await publish(db,restored)
    assert (await http.get(path)).status_code==200
    card=await content.create_item(db,ACTOR,'card',{'name':'Visible label','description':'Visible detail','visibility':'public'},None)
    await publish(db,card)
    await http.get('/')
    hidden=await content.update_item(db,ACTOR,card['id'],card['version'],{'visibility':'private'})
    await publish(db,hidden)
    assert await count(db)==0 and 'Visible label' not in (await http.get('/')).text


async def test_af_prebuild_share_card_and_theme(db,http):
    from server.app import sharecards,themes
    from server.app.db import dumps
    _,entry=await fixture(db)
    await http.get('/')
    before=await artifacts.snapshot(db)
    jpeg=bytes([255,216,255,192,0,17,8,2,118,4,176]+[7]*64)
    await sharecards.save(db,entry['id'],entry['version'],jpeg)
    assert await count(db)==0 and await artifacts.snapshot(db)!=before
    await http.get('/')
    base=themes.built_in()['personal-homepage']
    package=dumps({**base,'pages':{**base['pages'],'home':base['pages']['home']+'\n'}})
    async def fetcher(url):
        from httpx import Response
        return Response(200,json={'themes':[{'name':'personal-homepage','package':{'url':'https://catalog.example/look.json','sha256':artifacts.digest(package)}}]}) if url==themes.CATALOG_URL else Response(200,text=package)
    await themes.install(db,'personal-homepage',ACTOR,fetcher)
    assert await count(db)==0 and await artifacts.snapshot(db)!=before


async def test_af_prebuild_byte_budget(db,http):
    await fixture(db)
    first=await http.get('/')
    row=await db.fetchrow('SELECT * FROM public_artifacts LIMIT 1')
    await db.execute('DELETE FROM public_artifacts')
    chunk='x'*artifacts.MAX_BODY
    await db.executemany('INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size) VALUES($1,$2,$3,$4,$5,$6)',[(f'large-{i}',row['generation'],chunk,row['metadata'],row['valid_until'],artifacts.MAX_BODY) for i in range(16)])
    assert (await http.get('/')).content==first.content and await count(db)==16


async def test_af_prebuild_concurrent_budget(db,http):
    await fixture(db)
    await http.get('/')
    row=await db.fetchrow('SELECT * FROM public_artifacts LIMIT 1')
    await db.execute('DELETE FROM public_artifacts')
    await db.executemany('INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size) VALUES($1,$2,$3,$4,$5,$6)',[(f'occupied-{i}',row['generation'],'x',row['metadata'],row['valid_until'],1) for i in range(127)])
    replies=await asyncio.gather(*(http.get(path) for path in ['/','/index.md','/llms.txt','/journal/']))
    assert [r.status_code for r in replies]==[200]*4 and await count(db)==128


async def test_af_prebuild_metadata_policy(db,http):
    await fixture(db)
    first=await http.get('/')
    for name,value in [('content-security-policy',"default-src *; script-src 'unsafe-inline'"),('permissions-policy','camera=*'),('link','<https://outside.example/>; rel="alternate"')]:
        pairs=json.loads(await db.fetchval('SELECT metadata FROM public_artifacts LIMIT 1'))
        await db.execute('UPDATE public_artifacts SET metadata=$1',json.dumps([[k,value if k==name else v] for k,v in pairs]))
        repaired=await http.get('/')
        assert repaired.content==first.content and repaired.headers[name]==first.headers[name]


def test_af_prebuild_origin_grammar():
    from pathlib import Path
    cases=json.loads((Path(__file__).parents[3]/'spec/fixtures/public-artifact-origins.json').read_text())
    for case in cases:
        assert artifacts.configured_origin(case['value'])==case['origin']


async def test_af_prebuild_default_off(db,http,app,monkeypatch):
    from server.app import routes
    one,_=await fixture(db)
    from server.app.settings import Settings
    for flag in [None,'','0','true','2']:
        with monkeypatch.context() as patch:
            if flag is None:patch.delenv('PORCHSITE_PUBLIC_ARTIFACTS',raising=False)
            else:patch.setenv('PORCHSITE_PUBLIC_ARTIFACTS',flag)
            app.settings=replace(app.settings,public_artifacts=Settings.from_env().public_artifacts)
            assert not app.settings.public_artifacts
            assert (await http.get('/?PUBLIC_ARTIFACTS=1',headers={'PUBLIC_ARTIFACTS':'1'})).status_code==200
            assert await count(db)==0
    cx=routes.Context(db,app.settings.setup_code,app.provider,ORIGIN,app.settings.release)
    routes.schedule_public(cx)
    assert await count(db)==0
    app.settings=replace(app.settings,public_artifacts=True)
    await http.get('/')
    assert await count(db)==1
    draft=await content.update_item(db,ACTOR,'site',one['version'],{'title':'Approved new title'})
    await publish(db,draft)
    assert await count(db)==0


async def test_af_prebuild_no_owner_bytes(db,http):
    from server.app.owner import hash_token
    one,_=await fixture(db)
    visitor=await http.get('/')
    await db.execute('UPDATE auth_state SET owner_epoch=0 WHERE id=1')
    await db.execute("INSERT INTO sessions(token_hash,created_at,expires_at) VALUES($1,'2026-10-17','2099-01-01')",hash_token('owner-fixture'))
    await db.execute("INSERT INTO readers(id,name,created_at) VALUES('reader','Reader','2026-10-17')")
    await db.execute("INSERT INTO reader_passkeys(id,reader_id,public_key,created_at) VALUES('reader-key','reader',$1,'2026-10-17')",b'\0')
    await db.execute("INSERT INTO reader_sessions(token_hash,reader_id,credential_id,epoch,created_at,expires_at) VALUES($1,'reader','reader-key',0,'2026-10-17','2099-01-01')",hash_token('reader-fixture'))
    for role in ['owner','reader']:
        headers={'Cookie':f'__Host-sk_{role}={role}-fixture'}
        html=await http.get('/',headers=headers)
        assert 'no-store' in html.headers['cache-control'] and 'etag' not in html.headers
        assert ('sk-owner-link' in html.text)==(role=='owner')
        md=await http.get('/index.md',headers=headers)
        assert 'etag' not in md.headers and '/review' not in md.text
        for path in ['/nowhere/','/wp-admin/install.php']:
            missing=await http.get(path,headers=headers)
            assert missing.status_code==404
            assert ('sk-owner-link' in missing.text)==(role=='owner')
            assert 'no-store' in missing.headers['cache-control'] and 'etag' not in missing.headers
    assert await count(db)==1 and (await http.get('/')).content==visitor.content
    rows=[dict(r) for r in await db.fetch('SELECT body,metadata FROM public_artifacts')]
    assert 'sk-owner-link' not in json.dumps(rows) and '/review' not in json.dumps(rows)
    hidden=await content.update_item(db,ACTOR,'site',one['version'],{'private':True})
    await publish(db,hidden)
    private_tags=set()
    for role in ['owner','reader']:
        headers={'Cookie':f'__Host-sk_{role}={role}-fixture'}
        assert (await http.get('/',headers=headers)).status_code==200
        copy=await http.get('/index.md',headers=headers)
        assert copy.status_code==200 and copy.headers['cache-control']=='private, no-cache, must-revalidate, no-transform'
        tag=copy.headers['etag'];private_tags.add(tag)
        assert tag.startswith('W/"ag-sha256-') and '/review' not in copy.text
        assert (await http.get('/index.md',headers={**headers,'If-None-Match':tag})).status_code==304
    assert len(private_tags)==2
    for headers in ({},{'Authorization':'Bearer psk_unknown'},{'Authorization':'Bearer prk_unknown'},{'Cookie':'__Host-sk_owner=expired'}):
        denied=await http.get('/index.md',headers=headers)
        assert denied.status_code==404 and denied.text==(BLANK if 'Authorization' in headers else SIGN_IN) and 'etag' not in denied.headers
    assert await count(db)==0


async def test_af_prebuild_unpublish_race(db,http,monkeypatch):
    _,entry=await fixture(db)
    original=site.live_view
    entered,resume=asyncio.Event(),asyncio.Event()
    once=True
    async def barrier(*args,**kwargs):
        nonlocal once
        view=await original(*args,**kwargs)
        if once:
            once=False
            entered.set()
            await resume.wait()
        return view
    monkeypatch.setattr(site,'live_view',barrier)
    pending=asyncio.create_task(http.get('/journal/'+entry['slug']+'/'))
    await asyncio.wait_for(entered.wait(),5)
    gone=await content.remove_item(db,ACTOR,entry['id'],entry['version'])
    await publish(db,gone)
    resume.set()
    response=await pending
    assert response.status_code==404 and 'etag' not in response.headers and await count(db)==0


async def test_af_prebuild_local_midnight_notice_event(db,http,monkeypatch):
    from datetime import datetime
    from server.app import themes
    from server.app.db import dumps
    from httpx import Response
    one,entry=await fixture(db)
    dated=await content.update_item(db,ACTOR,'site',one['version'],{'theme':'event-page','timezone':'America/New_York','notice':{'text':'Until midnight only','until':'2026-11-01'}})
    await publish(db,dated)
    event=await content.update_item(db,ACTOR,entry['id'],entry['version'],{'event':{'start':'2026-11-01T23:59'}})
    await publish(db,event)
    base=themes.built_in()['event-page']
    package=dumps({**base,'pages':{**base['pages'],'entry':base['pages']['entry']+'<span data-past="{{#entry.event.is_past}}true{{/entry.event.is_past}}{{^entry.event.is_past}}false{{/entry.event.is_past}}"></span>'}})
    async def fetcher(url):
        return Response(200,json={'themes':[{'name':'event-page','package':{'url':'https://catalog.example/look.json','sha256':artifacts.digest(package)}}]}) if url==themes.CATALOG_URL else Response(200,text=package)
    await themes.install(db,'event-page',ACTOR,fetcher)
    current=datetime.fromisoformat('2026-11-02T04:59:30+00:00')
    original=site.live_view
    async def clocked(*args,**kwargs):
        view=await original(*args,**kwargs)
        view.now=current
        return view
    monkeypatch.setattr(site,'live_view',clocked)
    monkeypatch.setattr(artifacts.time,'time',lambda:current.timestamp())
    path='/journal/'+entry['slug']+'/'
    before=await http.get(path)
    assert 'Until midnight only' in before.text and 'data-past="false"' in before.text and await count(db)==1
    current=datetime.fromisoformat('2026-11-02T05:00:00+00:00')
    after=await http.get(path,headers={'If-None-Match':before.headers['etag']})
    assert after.status_code==200 and 'Until midnight only' not in after.text and 'data-past="true"' in after.text
    assert after.headers['etag']!=before.headers['etag'] and await count(db)==1


async def test_af_prebuild_failed_builder_keeps_publication(db,http,app,monkeypatch):
    from server.app import routes
    one,_=await fixture(db)
    draft=await content.update_item(db,ACTOR,'site',one['version'],{'title':'Committed despite failed build'})
    await publish(db,draft)
    cx=routes.Context(db,app.settings.setup_code,app.provider,ORIGIN,app.settings.release,True)
    req=artifacts.request_for(ORIGIN,'/')
    async def failed(*args,**kwargs):
        raise RuntimeError('build failure')
    with monkeypatch.context() as patch:
        patch.setattr(site,'live_view',failed)
        with pytest.raises(RuntimeError,match='build failure'):
            await artifacts.prepare(db,ORIGIN,app.settings.release,lambda r:routes.render_public(r,cx),lambda:routes.public_paths(req,cx))
    assert await db.fetchval("SELECT version FROM live WHERE item_id='site'")==draft['version']
    assert 'Committed despite failed build' in (await http.get('/')).text


@pytest.mark.parametrize('boundary',['snapshot','late'])
@pytest.mark.parametrize('change',['private','unpublish','expiry'])
async def test_af_prebuild_warm_hit_race(db,http,monkeypatch,change,boundary):
    one,entry=await fixture(db)
    path='/journal/'+entry['slug']+'/'
    first=await http.get(path)
    assert first.status_code==200 and await count(db)==1
    target='initial_facts' if boundary=='snapshot' else 'read_revision'
    original=getattr(content_revision,target)
    live=site.live_view
    rendered=0
    async def observed(*args,**kwargs):
        nonlocal rendered
        rendered+=1
        return await live(*args,**kwargs)
    monkeypatch.setattr(site,'live_view',observed)
    calls=0
    async def raced(*args,**kwargs):
        nonlocal calls
        stamp=await original(*args,**kwargs) if boundary=='snapshot' else None
        calls+=1
        if calls==1:
            # Commit after the snapshot or immediately before the independent late read.
            if change=='private':
                hidden=await content.update_item(db,ACTOR,'site',one['version'],{'private':True})
                await publish(db,hidden)
            elif change=='unpublish':
                gone=await content.remove_item(db,ACTOR,entry['id'],entry['version'])
                await publish(db,gone)
            else:
                expired=await db.fetchval('SELECT max(valid_until) FROM public_artifacts')
                monkeypatch.setattr(artifacts.time,'time',lambda:expired/1000+1)
        return stamp if boundary=='snapshot' else await original(*args,**kwargs)
    monkeypatch.setattr(content_revision,target,raced)
    response=await http.get(path,headers={'If-None-Match':first.headers['etag']})
    assert calls>0
    if change=='expiry':
        # Storage expiry is not a dependency; the static hit remains cheap.
        assert rendered==0 and response.status_code==304
        assert response.headers['etag']==first.headers['etag']
    else:
        assert response.status_code==404 and 'etag' not in response.headers
        assert await count(db)==0
        if change=='private':
            assert response.content==SIGN_IN.encode()


async def test_af_prebuild_visitor_fill(db,http):
    from starlette.responses import Response
    _,entry=await fixture(db)
    await http.get('/journal/'+entry['slug']+'/')
    assert await count(db)==1
    paths=[]
    async def render(req):
        paths.append(req.url.path)
        return Response('not stored',status_code=404)
    async def public_paths():
        return ['/archive/']
    await artifacts.prepare(db,ORIGIN,'test',render,public_paths)
    assert paths==['/','/index.md','/archive/','/archive/index.md','/llms.txt']

async def test_af_pipe_table_access(db,http,browser_factory):
    one,entry=await fixture(db)
    table=await content.update_item(db,ACTOR,entry['id'],entry['version'],{'body':'| Public | Value |\n| :-- | --: |\n| visible\\|cell | **12** |'})
    await publish(db,table)
    stream=one['data']['streams'][0]
    path='/'+(stream.get('path') or stream['id'])+'/'+table['slug']+'/'
    html=await http.get(path)
    assert html.status_code==200 and '<th scope="col" align="left">Public</th>' in html.text
    direct=await http.get(path+'index.md')
    body,tag=direct.text,direct.headers['etag']
    assert '| :--- | ---: |' in body and 'visible\\|cell' in body
    negotiated=await http.get(path,headers={'Accept':'text/markdown'})
    assert negotiated.text==body and negotiated.headers['etag']==tag
    for method in ['GET','HEAD']:
        response=await http.request(method,path+'index.md',headers={'If-None-Match':tag})
        assert response.status_code==304 and response.content==b''
    own,key=browser_factory(),SoftKey()
    options=await own.options('/setup/options',{'code':'test-setup-code','name':'owner'})
    assert (await own.post('/setup/verify',key.create(options,ORIGIN))).status_code==200
    owner_copy=await own.at(path+'index.md')
    assert owner_copy.text==body and 'no-store' in owner_copy.headers['cache-control'] and 'etag' not in owner_copy.headers
    assert 'Review' not in body
    pending=await content.update_item(db,ACTOR,table['id'],table['version'],{'body':'| SECRET_PENDING | H |\n| - | - |'})
    assert (await http.get(path+'index.md')).text==body
    for headers in [{'Cookie':'__Host-sk_owner=invalid'},{'Cookie':'__Host-sk_reader=invalid'},{'Authorization':'Bearer invalid'}]:
        response=await http.get(path+'index.md',headers=headers)
        assert 'no-store' in response.headers['cache-control'] and 'etag' not in response.headers
        assert 'SECRET_PENDING' not in response.text
    await content.remove_item(db,ACTOR,table['id'],pending['version'])
    await publish(db,await content.get_item(db,table['id']))
    removed=await http.get(path+'index.md',headers={'If-None-Match':tag})
    assert removed.status_code==404 and 'etag' not in removed.headers
    hidden=await content.update_item(db,ACTOR,'site',one['version'],{'private':True})
    await publish(db,hidden)
    for method in ['GET','HEAD']:
        response=await http.request(method,path+'index.md',headers={'If-None-Match':tag})
        assert response.status_code==404 and response.content==(SIGN_IN.encode() if method=='GET' else b'')

async def test_af_time_storage_cap(db,http,monkeypatch):
    await fixture(db)
    start=int(artifacts.time.time()*1000)
    now=start
    monkeypatch.setattr(artifacts.time,'time',lambda:now/1000)
    first=await http.get('/')
    tag=first.headers['etag'];body=first.content
    until=await db.fetchval('SELECT max(valid_until) FROM public_artifacts')
    assert until==start+86400000
    async def refused(*args,**kwargs):
        pytest.fail('static copy or cheap conditional must not render')
    monkeypatch.setattr(site,'live_view',refused)
    now=start+7200000
    warm=await http.get('/')
    assert warm.status_code==200 and warm.content==body and warm.headers['etag']==tag
    now=until+1
    hit=await http.get('/',headers={'If-None-Match':tag})
    assert hit.status_code==304 and hit.headers['etag']==tag

async def test_af_thin_hit_budget(db,monkeypatch):
    from unittest.mock import AsyncMock
    from server.app import routes
    from .test_agent_map import Count,request
    await fixture(db)
    async with db.acquire() as conn:
        counted=Count(conn);cx=routes.Context(counted,'',None,site_url=ORIGIN,public_artifacts=True)
        first=await routes.handle(request('/'),cx);await agent_traffic.settle(counted)
        body,tag=first.body,first.headers['etag']
        load=AsyncMock(wraps=site.live_view);facts=AsyncMock(wraps=public_read.facts);snap=AsyncMock(wraps=artifacts.snapshot)
        monkeypatch.setattr(site,'live_view',load);monkeypatch.setattr(public_read,'facts',facts);monkeypatch.setattr(artifacts,'snapshot',snap)
        for method in ('GET','HEAD'):
            counted.calls.clear();facts.reset_mock();load.reset_mock()
            r=await routes.handle(request('/',method=method),cx);await agent_traffic.settle(counted)
            assert r.status_code==200 and r.body==(b'' if method=='HEAD' else body)
            assert len(counted.calls)==4 and sum('LEFT JOIN public_artifacts' in q for q in counted.calls)==1
            assert facts.await_count==1 and load.await_count==0 and snap.await_count==0
        counted.calls.clear()
        conditional=await routes.handle(request('/',headers={'If-None-Match':tag}),cx)
        assert conditional.status_code==304 and len(counted.calls)==3 and not any('LEFT JOIN public_artifacts' in q for q in counted.calls)
        await db.execute('DELETE FROM public_artifacts');counted.calls.clear();facts.reset_mock();load.reset_mock()
        miss=await routes.handle(request('/'),cx);await agent_traffic.settle(counted)
        assert miss.body==body and load.await_count==1 and facts.await_count==2 and snap.await_count==0
        writes=[q for q in counted.calls if q.lstrip().upper().startswith(('INSERT','DELETE','UPDATE')) or 'INSERT INTO public_artifacts' in q]
        assert len(counted.calls)-len(writes)<=7 and len([q for q in writes if not q.startswith('INSERT INTO agent_traffic_daily')])==2 and len(counted.calls)<=10

async def test_af_thin_hit_old_runtime(db,http,monkeypatch):
    await fixture(db)
    first=await http.get('/');old=await db.fetchrow('SELECT generation,revision FROM public_artifact_state')
    await db.execute("UPDATE live SET data=jsonb_set(data::jsonb,'{title}','\"Old runtime publication\"'::jsonb)::text WHERE item_id='site'")
    from server.app import routes
    from .test_agent_map import Count,request
    async with db.acquire() as conn:
        counted=Count(conn);cx=routes.Context(counted,'',None,site_url=ORIGIN,public_artifacts=True)
        async def refuse(*args,**kwargs):
            pytest.fail('thin path called SNAPSHOT')
        monkeypatch.setattr(artifacts,'snapshot',refuse)
        f=await public_read.facts(conn,True);g=artifacts.generation(f,cx.release,ORIGIN)
        stored=await conn.fetchrow('SELECT key FROM public_artifacts LIMIT 1')
        refused=await conn.fetchrow(artifacts.lookup_sql(),json.dumps(f['raw'],separators=(',',':')),g,stored['key'])
        assert refused['facts_ok'] is True and refused['ok'] is False and refused['key'] is None and refused['body'] is None
        live=await routes.handle(request('/'),routes.Context(conn,'',None,site_url=ORIGIN,release=cx.release,public_artifacts=False))
        r=await routes.handle(request('/'),cx);await agent_traffic.settle(counted)
        assert b'Old runtime publication' in r.body and r.headers['etag']!=first.headers['etag']
        assert r.body==live.body and r.headers['etag']==live.headers['etag']
        lookup=[q for q in counted.calls if 'LEFT JOIN public_artifacts' in q]
        assert len(lookup)==0 and 'DELETE FROM public_artifacts' in counted.calls
        assert counted.calls.index(artifacts.STATE_SQL)<counted.calls.index('DELETE FROM public_artifacts')
        assert await db.fetchval('SELECT generation FROM public_artifact_state')!=old['generation']

@pytest.mark.parametrize('change',['private','unpublish','theme','title'])
async def test_af_thin_hit_races(db,http,monkeypatch,change):
    one,entry=await fixture(db);path='/journal/'+entry['slug']+'/'
    await http.get(path);original=public_read.facts;once=True
    async def raced(*args,**kwargs):
        nonlocal once
        f=await original(*args,**kwargs)
        if once:
            once=False
            if change=='private':
                await db.execute("INSERT INTO site_fields(version,key,value,approved)VALUES($1,'private','true',1) ON CONFLICT(version,key) DO UPDATE SET value='true',approved=1",one['version'])
                await db.execute('INSERT INTO private_approvals(version)VALUES($1) ON CONFLICT DO NOTHING',one['version'])
            elif change=='unpublish':
                await db.execute('DELETE FROM live WHERE item_id=$1',entry['id'])
            else:
                await db.execute("UPDATE live SET data=jsonb_set(data::jsonb,ARRAY[$1::text],$2::jsonb)::text WHERE item_id='site'",'theme' if change=='theme' else 'title',json.dumps('local-business' if change=='theme' else 'New approved title'))
        return f
    monkeypatch.setattr(public_read,'facts',raced)
    r=await http.get(path)
    if change in ('private','unpublish'):
        assert r.status_code==404 and 'etag' not in r.headers
        if change=='private': assert r.text==SIGN_IN
    else:
        assert r.status_code==200
        if change=='title': assert 'New approved title' in r.text

async def test_af_thin_hit_duplicate_tuple(db,http):
    await fixture(db);await http.get('/')
    f=await public_read.facts(db,True);row=await db.fetchrow('SELECT key,generation FROM public_artifacts LIMIT 1')
    raw=[r[:] for r in f['raw']];assert len(raw)>2;raw[0]=raw[1]
    result=await db.fetchrow(artifacts.proof_sql()+''' SELECT p.ok,a.body FROM proof p LEFT JOIN public_artifacts a ON p.ok AND a.key=$3 AND a.generation=$2''',json.dumps(raw),row['generation'],row['key'])
    assert not result['ok'] and result['body'] is None

async def test_af_thin_miss_lease(db):
    from starlette.responses import Response
    await fixture(db)
    started,resume=asyncio.Event(),asyncio.Event()
    first=True
    async def render(req):
        nonlocal first
        if first:
            first=False;started.set();await resume.wait()
        return Response('not stored',status_code=404)
    async def paths(): return []
    job=asyncio.create_task(artifacts.prepare(db,ORIGIN,'test',render,paths))
    await started.wait()
    token=await db.fetchval('SELECT preparing FROM public_artifact_state WHERE id=1');assert token
    competing=False
    async def other(req):
        nonlocal competing
        competing=True
        return Response('not stored',status_code=404)
    await artifacts.prepare(db,ORIGIN,'test',other,paths)
    assert not competing and await db.fetchval('SELECT preparing FROM public_artifact_state WHERE id=1')==token
    resume.set();await job
    assert await db.fetchval('SELECT preparing FROM public_artifact_state WHERE id=1')==''

async def test_af_thin_miss_admission_race(db,http,monkeypatch):
    await fixture(db);original=public_read.facts;calls=0
    async def raced(*args,**kwargs):
        nonlocal calls
        f=await original(*args,**kwargs);calls+=1
        if calls==2:
            await db.execute("UPDATE live SET data=jsonb_set(data::jsonb,'{title}','\"Admission race title\"'::jsonb)::text WHERE item_id='site'")
        return f
    monkeypatch.setattr(public_read,'facts',raced)
    r=await http.get('/')
    assert r.status_code==200 and 'Admission race title' in r.text and await count(db)==0

def test_af_thin_generation_encoding():
    from pathlib import Path
    cases=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/public-artifacts-thin.json').read_text())
    for c in cases:
        assert artifacts.generation(dict(rows=c['rows'],generation='not-authority',revision=99),'fixture','https://example.com')==c['sha256'],c['name']

async def test_af_thin_hit_query_plan(db,http):
    await fixture(db);await http.get('/')
    f=await public_read.facts(db,True);row=await db.fetchrow('SELECT key,generation FROM public_artifacts LIMIT 1')
    sql=artifacts.proof_sql()+''' SELECT p.ok,a.key FROM proof p LEFT JOIN public_artifacts a ON p.ok AND a.key=$3 AND a.generation=$2'''
    args=(json.dumps(f['raw']),row['generation'],row['key'])
    before=await db.fetchrow(sql,*args)
    await db.execute("INSERT INTO media(name,type,size,data,created_at) SELECT lpad(to_hex(n),32,'0')||'.png','image/png',1,decode('00','hex'),'2026-10-18' FROM generate_series(1,500) n")
    after=await db.fetchrow(sql,*args)
    assert dict(after)==dict(before) and after['ok']
    plan=json.loads(await db.fetchval('EXPLAIN (ANALYZE,FORMAT JSON) '+sql,*args))
    def nodes(node):
        yield node
        for p in node.get('Plans',[]): yield from nodes(p)
    image_nodes=[p for p in nodes(plan[0]['Plan']) if p.get('Relation Name')=='media']
    assert all(p['Actual Rows']==0 for p in image_nodes)
    print(json.dumps({'case':'af_thin_hit_budget','unused_images':500,'image_access':[{k:p.get(k) for k in ['Node Type','Index Name','Actual Rows','Actual Loops']} for p in image_nodes]}))

async def test_af_thin_state_outage(db,http,monkeypatch):
    from server.app import routes
    from .test_agent_map import Count,request
    one,_=await fixture(db);first=await http.get('/')
    await db.execute('ALTER TABLE public_artifact_state RENAME TO unavailable_artifact_state')
    try:
        async with db.acquire() as conn:
            counted=Count(conn);cx=routes.Context(counted,'',None,site_url=ORIGIN,public_artifacts=True)
            live=await routes.handle(request('/'),cx)
            assert live.status_code==200 and live.body==first.content and counted.calls.count(artifacts.STATE_SQL)==1
            await db.execute("INSERT INTO site_fields(version,key,value,approved)VALUES($1,'private','true',1) ON CONFLICT(version,key) DO UPDATE SET value='true',approved=1",one['version'])
            await db.execute('INSERT INTO private_approvals(version)VALUES($1) ON CONFLICT DO NOTHING',one['version'])
            denied=await routes.handle(request('/'),cx)
            assert denied.status_code==404 and denied.body.decode()==SIGN_IN and 'etag' not in denied.headers and counted.calls.count(artifacts.STATE_SQL)==1
    finally:
        await db.execute('ALTER TABLE unavailable_artifact_state RENAME TO public_artifact_state')

async def test_af_thin_fill_clock_race(db,monkeypatch):
    from datetime import datetime,UTC
    from server.app import routes
    from .test_agent_map import request
    one,_=await fixture(db)
    await publish(db,await content.update_item(db,ACTOR,'site',one['version'],dict(theme='event-page',timezone='UTC',notice=dict(text='Only before midnight',until='2026-11-01'))))
    before=datetime(2026,11,1,23,59,30,tzinfo=UTC).timestamp();after=datetime(2026,11,2,tzinfo=UTC).timestamp()
    monkeypatch.setattr(artifacts.time,'time',lambda:before)
    cx=routes.Context(db,'',None,site_url=ORIGIN,release='time-race',public_artifacts=False)
    req=request('/');old_tag=''
    async def render():
        nonlocal old_tag
        r=await routes.handle(req,cx)
        assert b'Only before midnight' in r.body
        old_tag=r.headers['etag'];monkeypatch.setattr(artifacts.time,'time',lambda:after)
        return r
    async def refresh(): return await routes.handle(req,cx)
    r=await artifacts.respond(db,req,ORIGIN,'time-race',render,refresh=refresh)
    await agent_traffic.settle(db)
    assert r.status_code==200 and b'Only before midnight' not in r.body and r.headers['etag']!=old_tag and await count(db)==0
