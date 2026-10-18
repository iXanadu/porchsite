"""Image sizing reads never mutate metadata or trigger a second public render."""
import base64
from unittest.mock import AsyncMock, Mock
import pytest
from server.app import media, image_add, content, approvals, routes, site, theme, agent_traffic
from .test_agent_map import Count, request
from .conftest import TABLES
PNG=bytes([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,2,0,0,0,1,0])
ORIGIN='https://site.example'

@pytest.fixture(autouse=True)
async def clear(db):
    agent_traffic.reset(db)
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    await db.execute('INSERT INTO public_artifact_state(id)VALUES(1) ON CONFLICT DO NOTHING')
    await db.execute("UPDATE public_artifact_state SET generation='',revision=0,preparing='',prepare_until=0 WHERE id=1")

async def unsized(db):
    path=await media.store(db,PNG,'image/png','fixture')
    name=path[7:]
    await db.execute('UPDATE media SET width=0,height=0 WHERE name=$1',name)
    return path,name

async def prepared(db):
    await db.execute("INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size)VALUES('retained','generation','body','{}',9999999999999,4)")

async def test_perf3_read_only_size(db):
    _,name=await unsized(db)
    await prepared(db)
    before=await db.fetchrow('SELECT * FROM public_artifact_state')
    counted=Count(db)
    assert await media.size_of(counted,name)==(512,256)
    assert await media.size_of(counted,name)==(512,256)
    assert all(sql.startswith('SELECT') for sql in counted.calls)
    assert await db.fetchval('SELECT width FROM media WHERE name=$1',name)==0
    assert await db.fetchrow('SELECT * FROM public_artifact_state')==before
    assert await db.fetchval('SELECT count(*) FROM public_artifacts')==1
    assert await media.size_of(db,'absent.png')==(0,0)

@pytest.mark.parametrize('mode',['store','image_add'])
async def test_perf3_upload_backfill(db,mode):
    path,name=await unsized(db)
    await prepared(db)
    if mode=='store':
        assert await media.store(db,PNG,'image/png','fixture')==path
    else:
        result=await image_add.image_add(db,'assistant:test',images=[base64.b64encode(PNG).decode()])
        assert result['images']==[{'image':path,'width':512,'height':256}]
    row=await db.fetchrow('SELECT width,height FROM media WHERE name=$1',name)
    assert tuple(row)==(512,256)
    assert await db.fetchval('SELECT count(*) FROM public_artifacts')==0
    assert await db.fetchval('SELECT revision FROM public_artifact_state')==1
    assert (await media.serve(db,name,True))['body']==PNG

async def test_perf3_legacy_hero_get_head(db,monkeypatch):
    path,name=await unsized(db)
    item=await content.create_item(db,'assistant:test','site',{'title':'Legacy hero','theme':'personal-homepage','hero':path,'hero_alt':'A wide image'},None)
    await approvals.publish_now(db,[{'id':'site','version':item['version']}],'',ORIGIN)
    counted=Count(db)
    cx=routes.Context(counted,'',None)
    await routes.handle(request('/'),cx)
    await agent_traffic.settle(counted)
    await prepared(db)
    load=AsyncMock(wraps=site.live_view)
    render=Mock(wraps=theme.render)
    monkeypatch.setattr(site,'live_view',load)
    monkeypatch.setattr(routes,'render',render)
    for method in ['GET','HEAD']:
        counted.calls.clear();load.reset_mock();render.reset_mock()
        response=await routes.handle(request('/',method),cx)
        await agent_traffic.settle(counted)
        assert response.status_code==200
        tag=response.headers['etag']
        assert load.await_count==1 and render.call_count==1
        assert len(counted.calls)<=14
        assert all(not sql.lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for sql in counted.calls)
        assert b'width="512"' in response.body if method=='GET' else response.body==b''
    counted.calls.clear();load.reset_mock()
    hit=await routes.handle(request('/',headers={'If-None-Match':tag}),cx)
    assert hit.status_code==304 and hit.body==b'' and load.await_count==0
    assert len(counted.calls)<=3
    assert all('SELECT data FROM media' not in sql for sql in counted.calls)
    assert await db.fetchval('SELECT width FROM media WHERE name=$1',name)==0
    assert await db.fetchval('SELECT count(*) FROM public_artifacts')==1

@pytest.mark.parametrize('asked,selected',[('classic','personal-homepage'),('broadsheet','product-page'),('custom-look','custom-look')])
async def test_perf3_bounded_facts(db,asked,selected):
    from server.app import public_read
    path,name=await unsized(db)
    item=await content.create_item(db,'assistant:test','site',{'title':'Dependency test','theme':asked,'hero':path,'hero_alt':'Hero'},None)
    await approvals.publish_now(db,[{'id':'site','version':item['version']}],'',ORIGIN)
    await db.executemany("INSERT INTO media(name,type,size,data,source,created_at,width,height)VALUES($1,'image/png',0,$2,'fixture','2026-10-17',1,1)",[(format(i,'032x')+'.png',b'') for i in range(500)])
    await db.execute("INSERT INTO themes(name,version,package,sha256,installed_at,installed_by)VALUES($1,'1','{}','selected-digest','2026-10-17','assistant:test'),('unused-look','1','{}','unused-digest','2026-10-17','assistant:test')",selected)
    req=request('/')
    first=await public_read.facts(db)
    choice=public_read.choice(req,first)
    assert [row for row in first['rows'] if row[0]=='media']==[['media',name,[0,0]]]
    assert [row for row in first['rows'] if row[0]=='theme']==[['theme',selected,['1','selected-digest']]]
    tag=public_read.tag(first,req,choice,'test',0)
    await db.execute('UPDATE media SET width=2 WHERE name<>$1',name)
    await db.execute("UPDATE themes SET sha256='unused-new' WHERE name='unused-look'")
    assert public_read.tag(await public_read.facts(db),req,choice,'test',0)==tag
    await db.execute('UPDATE media SET width=512,height=256 WHERE name=$1',name)
    resized=public_read.tag(await public_read.facts(db),req,choice,'test',0)
    assert resized!=tag
    await db.execute("UPDATE themes SET sha256='selected-new' WHERE name=$1",selected)
    assert public_read.tag(await public_read.facts(db),req,choice,'test',0)!=resized

async def test_perf3_local_hero_pattern(db):
    import json
    from server.app import public_read
    item=await content.create_item(db,'assistant:test','site',{'title':'Local paths'},None)
    await approvals.publish_now(db,[{'id':'site','version':item['version']}],'',ORIGIN)
    data=json.loads(await db.fetchval("SELECT data FROM live WHERE item_id='site'"))
    for hero in ['', 'https://example.com/photo.png', '/media/not-a-hash.png','/media/'+'A'*32+'.png','/media/'+'b'*32+'.gif']:
        if hero:
            await db.execute("INSERT INTO media(name,type,size,data,source,created_at,width,height)VALUES($1,'image/png',0,$2,'fixture','2026-10-17',512,256) ON CONFLICT DO NOTHING",hero[7:],b'')
        data['hero']=hero
        await db.execute("UPDATE live SET data=$1 WHERE item_id='site'",json.dumps(data))
        assert [r for r in (await public_read.facts(db))['rows'] if r[0]=='media']==[]
    for ext in ['jpg','png','webp']:
        name='c'*32+'.'+ext
        await db.execute("INSERT INTO media(name,type,size,data,source,created_at,width,height)VALUES($1,'image/png',0,$2,'fixture','2026-10-17',512,256)",name,b'')
        data['hero']='/media/'+name
        await db.execute("UPDATE live SET data=$1 WHERE item_id='site'",json.dumps(data))
        assert [r for r in (await public_read.facts(db))['rows'] if r[0]=='media']==[['media',name,[512,256]]]
