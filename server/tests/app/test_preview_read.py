"""Pinned same-principal inspection; paired with the Worker preview tests."""
import json
import pytest
from server.app import preview_read as preview,content,approvals,mcp,read_keys
from server.app.agent_markdown import markdown_document
from server.app.errors import ApiError
from .conftest import TABLES
ORIGIN='https://site.example'
ACTOR='assistant:test'
AUTHORITY={'principal':'writer:test','epoch':0}
async def authorize():return AUTHORITY
CONTEXT=dict(origin=ORIGIN,authorize=authorize)
@pytest.fixture(autouse=True)
async def clear(db,monkeypatch):
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    await db.execute('UPDATE auth_state SET owner_epoch=0 WHERE id=1')
    monkeypatch.setattr(preview.time,'time',lambda:1792324800)
async def publish(db,item):await approvals.publish_now(db,[dict(id=item['id'],version=item['version'])],'',ORIGIN)
async def fixture(db,theme='personal-homepage'):
    site=await content.create_item(db,ACTOR,'site',dict(title='Inspection site',theme=theme,streams=[dict(id='journal',title='Notes')],archive=dict(enabled=True,title='All entries')),None);await publish(db,site)
    entry=await content.create_item(db,ACTOR,'entry',dict(title='Selected title',body='Approved baseline.',date='2026-10-18'),None);await publish(db,entry)
    pending=await content.update_item(db,ACTOR,entry['id'],entry['version'],dict(body='Pending selected text.'))
    approval=await approvals.request(db,ACTOR,[pending['id']],'Inspect')
    await content.create_item(db,ACTOR,'entry',dict(title='UNRELATED_DRAFT',body='Unrelated staged text.',date='2026-10-18'),None)
    return site,entry,pending,approval,'/journal/'+entry['slug']+'/'
async def error(code,awaitable):
    with pytest.raises(ApiError) as e:await awaitable
    assert e.value.code==code
async def test_preview_overlay(db):
    _,entry,pending,approval,path=await fixture(db)
    before=await db.fetchval('SELECT COUNT(*) FROM public_artifacts')
    for page in ['/',path,'/archive/']:
        for format in ['html','markdown']:
            out=await preview.read(db,dict(approval_id=approval['id'],path=page,format=format),CONTEXT)
            assert out['notice']==preview.NOTICE and out['items']==[dict(id=entry['id'],version=pending['version'])]
            assert 'UNRELATED_DRAFT' not in out['body'] and 'Approved baseline.' not in out['body']
            if page==path:assert 'Pending selected text.' in out['body']
            for text in ('href=','src=','action=','style=','<script','<form','csrf','/review/'):assert text not in out['body']
    assert await db.fetchval('SELECT COUNT(*) FROM public_artifacts')==before
@pytest.mark.parametrize('path',['/review/','/media/','//example.com/','/a/../','/a/%2f/','/a/?q=x','/a/#x','/a/index.md','https://example.com/','/\ud800/'])
async def test_preview_path(db,path):await error('invalid',preview.read(db,dict(approval_id='abcdefgh',path=path),CONTEXT))
async def test_preview_authority(db):
    async def denied():raise ValueError('revoked')
    for ctx in (None,dict(origin=ORIGIN,authorize=denied)):await error('unauthorized',preview.read(db,dict(approval_id='abcdefgh'),ctx))
    _,_,_,approval,_=await fixture(db);calls=0
    async def revoked():
        nonlocal calls
        calls+=1
        if calls>=3:raise ValueError('revoked')
        return AUTHORITY
    await error('unauthorized',preview.read(db,dict(approval_id=approval['id']),dict(origin=ORIGIN,authorize=revoked)))
@pytest.mark.parametrize('kind',['live','revision','approval','epoch'])
async def test_preview_closure(db,kind):
    _,_,pending,approval,path=await fixture(db);calls=0
    async def mutate():
        nonlocal calls
        calls+=1
        if calls==2:
            if kind=='live':await db.execute("UPDATE live SET data=replace(data,'Inspection site','Changed baseline') WHERE item_id='site'")
            if kind=='revision':await db.execute("UPDATE revisions SET data=replace(data,'Pending selected text.','Changed revision.') WHERE item_id=$1 AND version=$2",pending['id'],pending['version'])
            if kind=='approval':await db.execute("UPDATE approvals SET status='decided' WHERE id=$1",approval['id'])
        return {**AUTHORITY,'epoch':1 if kind=='epoch' and calls>=3 else 0}
    await error('unauthorized' if kind=='epoch' else 'content_changed',preview.read(db,dict(approval_id=approval['id'],path=path),dict(origin=ORIGIN,authorize=mutate)))
async def test_preview_stale(db):
    _,_,pending,approval,_=await fixture(db)
    await content.update_item(db,ACTOR,pending['id'],pending['version'],dict(title='Newer title'))
    await error('approval_changed',preview.read(db,dict(approval_id=approval['id']),CONTEXT))
def test_preview_inert():
    source='<html><head><base href="https://bad.example"><link href="x"><script>SECRET_SCRIPT</script></head><body><main><a href="/review/x" ping="x">Visible link</a><img src="/media/draft.png" alt="Draft image"><iframe src="https://bad.example">SECRET_FRAME</iframe><form action="/review/x"><input value="SECRET_CSRF"></form><svg><a href="x">SECRET_SVG</a></svg><table><tr><th scope="row" colspan="2" onclick="x">Cell</th><td rowspan="1001">Other</td></tr></table><ol start="-2" style="color:red"><li>Literal text.</li></ol></main></body></html>'
    safe=preview.inert(source);md=markdown_document(safe,ORIGIN+'/',False)['markdown']
    assert '<th colspan="2" scope="row">Cell</th>' in safe and '<ol start="-2">' in safe
    for text in ('href=','src=','onclick','SECRET_','rowspan=','https://','style=','<form','<svg'):assert text not in safe
    assert 'Visible link' in md and 'Draft image' in md and ORIGIN not in md and '](' not in md

from dataclasses import replace
from server.app import keys,oauth
from .test_read_keys import rpc
@pytest.mark.parametrize('fallback',[False,True])
@pytest.mark.parametrize('credential',['key','oauth'])
async def test_preview_transport(db,http,app,fallback,credential):
    app.settings=replace(app.settings,site_url=ORIGIN)
    _,_,_,approval,path=await fixture(db)
    key=await keys.create(db,'Drafting')
    token=key['token'] if credential=='key' else await oauth.mint(db,'Drafting',ORIGIN)
    reader=await read_keys.create(db,'Reading')
    response,out=await rpc(http,token,'tools/call',dict(name='preview_read',arguments=dict(approval_id=approval['id'],path=path)),fallback)
    assert not out['result'].get('isError') and 'Pending selected text.' in json.loads(out['result']['content'][0]['text'])['body']
    assert response.headers['cache-control']=='private, no-store, no-transform'
    _,listed=await rpc(http,reader['token'],'tools/list',fallback=fallback)
    assert len(listed['result']['tools'])==5 and all(t['name']!='preview_read' for t in listed['result']['tools'])
    _,denied=await rpc(http,reader['token'],'tools/call',dict(name='preview_read',arguments=dict(approval_id=approval['id'])),fallback)
    assert denied.get('error') or denied.get('result',{}).get('isError')
    assert 'Pending selected text.' not in json.dumps(denied)
    app.settings=replace(app.settings,site_url='')
    _,missing=await rpc(http,token,'tools/call',dict(name='preview_read',arguments=dict(approval_id=approval['id'])),fallback)
    assert missing['result']['isError'] and 'Pending selected text.' not in json.dumps(missing)
async def test_preview_bounds(db):
    _,_,pending,_,path=await fixture(db)
    large=await content.update_item(db,ACTOR,pending['id'],pending['version'],dict(body='&'*60000))
    approval=await approvals.request(db,ACTOR,[large['id']],'Large')
    for format in ('html','markdown'):await error('preview_too_large',preview.read(db,dict(approval_id=approval['id'],path=path,format=format),CONTEXT))
async def test_preview_clock(db,monkeypatch):
    site,_,pending,_,_=await fixture(db)
    proposed=await content.update_item(db,ACTOR,'site',site['version'],dict(notice=dict(text='Only today.',until='2026-10-18')))
    approval=await approvals.request(db,ACTOR,[proposed['id'],pending['id']],'Clock')
    from datetime import datetime
    for start,end in [('2026-10-18T23:59:59+00:00','2026-10-19T00:00:00+00:00'),('2026-10-18T12:00:00+00:00','2026-10-18T11:59:59+00:00')]:
        now=[datetime.fromisoformat(start).timestamp()];calls=0
        monkeypatch.setattr(preview.time,'time',lambda:now[0])
        async def moving():
            nonlocal calls
            calls+=1
            if calls==2:now[0]=datetime.fromisoformat(end).timestamp()
            return AUTHORITY
        await error('content_changed',preview.read(db,dict(approval_id=approval['id']),dict(origin=ORIGIN,authorize=moving)))

from pathlib import Path
INERT=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/preview-inert.json').read_text())
@pytest.mark.parametrize('case',INERT,ids=lambda c:c['name'])
def test_preview_shared_inert(case):assert preview.inert(case['source'])==case['html']
async def test_preview_private(db,http,app):
    app.settings=replace(app.settings,site_url=ORIGIN)
    site,_,_,approval,path=await fixture(db)
    hidden=await content.update_item(db,ACTOR,'site',site['version'],dict(private=True));await publish(db,hidden)
    key=await keys.create(db,'Drafting')
    _,out=await rpc(http,key['token'],'tools/call',dict(name='preview_read',arguments=dict(approval_id=approval['id'],path=path)))
    assert not out['result'].get('isError') and 'Pending selected text.' in json.loads(out['result']['content'][0]['text'])['body']
    for headers in ({},{'Cookie':'__Host-sk_owner=invalid'},{'Authorization':'Bearer invalid','Cookie':'__Host-sk_owner=invalid'}):
        response=await http.post('/mcp',json=dict(jsonrpc='2.0',id=1,method='tools/call',params=dict(name='preview_read',arguments=dict(approval_id=approval['id']))),headers={**headers,'Accept':'application/json'})
        assert response.status_code==401 and 'Pending selected text.' not in response.text
async def test_preview_purity(db,http,app,monkeypatch):
    _,_,_,approval,path=await fixture(db);sql=[]
    class Captured:
        async def fetch(self,statement,*args):
            sql.append(statement)
            return await db.fetch(statement,*args)
    await preview.read(Captured(),dict(approval_id=approval['id'],path=path),CONTEXT)
    assert sql==[preview.SNAPSHOT_SQL,preview.SNAPSHOT_SQL]
    app.settings=replace(app.settings,site_url=ORIGIN,public_artifacts=True)
    from server.app import routes
    scheduled=[]
    monkeypatch.setattr(routes,'schedule_public',lambda ctx:scheduled.append(ctx))
    key=await keys.create(db,'Drafting')
    _,out=await rpc(http,key['token'],'tools/call',dict(name='preview_read',arguments=dict(approval_id=approval['id'],path=path)))
    assert not out['result'].get('isError') and scheduled==[]
    assert await db.fetchval('SELECT COUNT(*) FROM public_artifacts')==0
from server.app import themes
@pytest.mark.parametrize('name',[*themes.built_in(),'built-in','inspection-custom'])
async def test_preview_looks(db,name):
    if name=='inspection-custom':
        from copy import deepcopy
        look=deepcopy(themes.built_in()['personal-homepage']);look['manifest']['name']=name
        look['pages']['home']='<html><body><main><h1>{{site.title}}</h1><a href="/review/secret">Visible label</a><img src="/media/draft.png" alt="Draft photo"><script>SECRET_SCRIPT</script></main></body></html>'
        await db.execute("INSERT INTO themes(name,version,package,sha256,installed_at,installed_by,source) VALUES($1,'1',$2,'fixture','2026-10-18','assistant:test','private')",name,json.dumps(look))
    _,_,_,approval,path=await fixture(db,name)
    for page in ['/',path,'/archive/']:
        for format in ['html','markdown']:
            out=await preview.read(db,dict(approval_id=approval['id'],path=page,format=format),CONTEXT)
            assert preview.NOTICE in out['body']
            for text in ('href=','src=','action=','style=','<script','SECRET_SCRIPT','/review/secret'):assert text not in out['body']
            if page=='/archive/':assert 'Selected title' in out['body']
@pytest.mark.parametrize('kind',['field','embed','streams','private','training','theme','share'])
async def test_preview_dependency(db,kind):
    site,_,pending,approval,path=await fixture(db);calls=0
    async def mutate():
        nonlocal calls
        calls+=1
        if calls==2:
            if kind=='field':await db.execute("INSERT INTO site_fields(version,key,value,approved) VALUES($1,'broker','\"https://broker.example\"',1)",site['version'])
            if kind=='embed':await db.execute("UPDATE site_embed_sources SET sources='[\"https://player.example\"]' WHERE version=$1",site['version'])
            if kind=='streams':await db.execute("UPDATE site_stream_settings SET settings=replace(settings,'All entries','Changed archive') WHERE version=$1",site['version'])
            if kind in ('private','training'):await db.execute(f"INSERT INTO {'private_approvals' if kind=='private' else 'training_approvals'}(version) VALUES($1)",site['version'])
            if kind=='theme':await db.execute("INSERT INTO themes(name,version,package,sha256,installed_at,installed_by) VALUES('personal-homepage','1',$1,'changed','2026-10-18','assistant:test')",json.dumps(themes.built_in()['personal-homepage']))
            if kind=='share':await db.execute("INSERT INTO share_cards(item_id,version,name,created_at) VALUES($1,$2,'fixture.png','2026-10-18')",pending['id'],pending['version'])
        return AUTHORITY
    await error('content_changed',preview.read(db,dict(approval_id=approval['id'],path=path),dict(origin=ORIGIN,authorize=mutate)))
async def test_preview_media(db):
    _,_,_,approval,_=await fixture(db);name='a'*32+'.png';header=bytes([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,2,128,0,0,1,224])
    await db.execute("INSERT INTO media(name,type,size,data,created_at,width,height) VALUES($1,'image/png',24,$2,'2026-10-18',0,0)",name,header)
    await db.execute("UPDATE live SET data=(data::jsonb || jsonb_build_object('hero',$1::text))::text WHERE item_id='site'",'/media/'+name)
    rows=await preview.capture(db,approval['id']);assert preview.view(rows,preview.time.time()*1000)[0].hero_size==(640,480)
    await preview.read(db,dict(approval_id=approval['id']),CONTEXT)
    assert await db.fetchval('SELECT width FROM media WHERE name=$1',name)==0
    calls=0
    async def mutate():
        nonlocal calls
        calls+=1
        if calls==2:await db.execute('UPDATE media SET width=100,height=50 WHERE name=$1',name)
        return AUTHORITY
    await error('content_changed',preview.read(db,dict(approval_id=approval['id']),dict(origin=ORIGIN,authorize=mutate)))
async def test_preview_decisions(db):
    _,_,pending,approval,path=await fixture(db)
    items=[{**x,'status':'published'} for x in approval['items']]
    await db.execute('UPDATE approvals SET items=$1 WHERE id=$2',json.dumps(items),approval['id'])
    await error('approval_changed',preview.read(db,dict(approval_id=approval['id']),CONTEXT))
    removed=await content.remove_item(db,ACTOR,pending['id'],pending['version']);approval=await approvals.request(db,ACTOR,[removed['id']],'Remove')
    await error('not_found',preview.read(db,dict(approval_id=approval['id'],path=path),CONTEXT))
async def test_preview_time_proof(db,monkeypatch):
    site,_,pending,approval,_=await fixture(db);now=[preview.time.time()];calls=0
    monkeypatch.setattr(preview.time,'time',lambda:now[0])
    async def moving():
        nonlocal calls
        calls+=1
        if calls==2:now[0]+=3660
        return AUTHORITY
    quiet=await preview.read(db,dict(approval_id=approval['id']),dict(origin=ORIGIN,authorize=moving))
    assert preview.NOTICE in quiet['body']
    proposed=await content.update_item(db,ACTOR,'site',site['version'],dict(notice=dict(text='Future notice',until='2200-01-01')))
    approval=await approvals.request(db,ACTOR,[proposed['id'],pending['id']],'Unknown clock')
    from datetime import datetime
    now[0]=datetime.fromisoformat('2200-01-01T12:00:00+00:00').timestamp()
    await error('preview_unavailable',preview.read(db,dict(approval_id=approval['id']),CONTEXT))
async def test_preview_no_audience(db,http):
    _,_,pending,_,page=await fixture(db);name='b'*32+'.png';path='/media/'+name;header=bytes([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1])
    await db.execute("INSERT INTO media(name,type,size,data,created_at,width,height) VALUES($1,'image/png',24,$2,'2026-10-18',1,1)",name,header)
    item=await content.update_item(db,ACTOR,pending['id'],pending['version'],dict(body=f'![Draft photo]({path})'));approval=await approvals.request(db,ACTOR,[item['id']],'Photo')
    assert (await http.get(path)).status_code==404
    out=await preview.read(db,dict(approval_id=approval['id'],path=page),CONTEXT)
    assert 'Draft photo' in out['body'] and path not in out['body']
    assert (await http.get(path)).status_code==404
_userinfo_origin=preview.URL(ORIGIN)
_userinfo_origin.username='owner'
@pytest.mark.parametrize('configured',['','http://site.example','https://site.example/path','https://site.example:bad',_userinfo_origin.href[:-1],'https://site.example/?x=1','https://site.example/#fragment'])
async def test_preview_origin(db,configured):await error('preview_unavailable',preview.read(db,dict(approval_id='abcdefgh'),{**CONTEXT,'origin':configured}))

async def test_preview_refusal_purity(db,http,app,monkeypatch):
    _,_,_,approval,_=await fixture(db)
    app.settings=replace(app.settings,site_url=ORIGIN,public_artifacts=True)
    from server.app import routes
    scheduled=[]
    monkeypatch.setattr(routes,'schedule_public',lambda ctx:scheduled.append(ctx))
    key=await keys.create(db,'Drafting')
    for body in [
        dict(jsonrpc='2.0',id=1,method='tools/call',params=dict(name='preview_read',arguments={},_meta=dict(test=True))),
        [dict(jsonrpc='2.0',id=1,method='tools/call',params=dict(name='preview_read',arguments=dict(approval_id=approval['id'])))],
    ]:
        await http.post('/mcp',json=body,headers={'Authorization':'Bearer '+key['token'],'Accept':'application/json, text/event-stream'})
        assert scheduled==[]
        assert await db.fetchval('SELECT COUNT(*) FROM public_artifacts')==0

def test_preview_structural_bounds():
    safe=preview.inert('<ol start="'+'9'*5000+'"><li>Large</li></ol><ol start="'+'0'*5000+'2"><li>Leading zeros</li></ol>')
    assert '<ol><li>Large</li></ol><ol start="2"><li>Leading zeros</li></ol>' in safe
