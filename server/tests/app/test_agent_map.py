"""One approved view, bounded map data, fixed query cost; paired with Worker."""
import json
from datetime import UTC, datetime, timedelta
import pytest
from starlette.requests import Request
from server.app import content, approvals, routes, site, theme, agent_markdown
from server.app.privacy import SIGN_IN
from .conftest import TABLES

ORIGIN, ACTOR = 'https://site.example', 'assistant:test'

@pytest.fixture(autouse=True)
async def clear(db):
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    await db.execute('UPDATE auth_state SET owner_epoch=0 WHERE id=1')

async def seed(db, n):
    item = await content.create_item(db, ACTOR, 'site', {'title':'Published title','description':'Approved description','tagline':'Different visible heading','theme':'personal-homepage','archive':{'enabled':True,'title':'All entries'}}, None)
    await approvals.publish_now(db,[{'id':'site','version':1}],'',ORIGIN)
    for i in range(n):
        ident, slug = 'ent_'+str(i), 'page-'+str(i).zfill(3)
        stamp = (datetime(2026,10,17,12,tzinfo=UTC)+timedelta(seconds=i)).isoformat(timespec='milliseconds').replace('+00:00','Z')
        data = json.dumps(content.validate('entry', {'title':'Entry '+str(i),'date':'2026-10-17','summary':'Summary '+str(i) if i%2 else '', 'body':'Body only marker '+'long body '*200}))
        await db.execute("INSERT INTO items(id,kind,slug,version,data,deleted,created_at,updated_at) VALUES ($1,'entry',$2,1,$3,FALSE,$4,$4)",ident,slug,data,stamp)
        await db.execute("INSERT INTO live(item_id,kind,slug,version,data,published_at) VALUES ($1,'entry',$2,1,$3,$4)",ident,slug,data,stamp)
    await content.update_item(db,ACTOR,'site',item['version'],{'title':'PENDING_TITLE_CANARY'})

class Count:
    def __init__(self, db):
        self.db, self.calls = db, []
    def __getattr__(self, name):
        original = getattr(self.db, name)
        if name not in ('fetch','fetchrow','fetchval','execute','executemany'):
            return original
        async def run(sql,*args,**kwargs):
            self.calls.append(sql)
            return await original(sql,*args,**kwargs)
        return run

def request(path='/llms.txt',method='GET',headers=None):
    return Request({'type':'http','method':method,'scheme':'https','server':('site.example',443),'path':path,'raw_path':path.encode(),'query_string':b'','headers':[(k.lower().encode(),v.encode()) for k,v in (headers or {}).items()]})

@pytest.mark.parametrize('n',[2,200])
async def test_af_ll1_constant_queries(db,monkeypatch,n):
    await seed(db,n)
    counts=Count(db)
    cx=routes.Context(counts,'',None)
    original=site.live_view
    loads=[]
    async def load(*args,**kwargs):
        loads.append(True)
        return await original(*args,**kwargs)
    def refuse(*args,**kwargs):
        pytest.fail('map must not render HTML or a full Markdown copy')
    monkeypatch.setattr(site,'live_view',load)
    monkeypatch.setattr(theme,'render',refuse)
    monkeypatch.setattr(routes,'render',refuse)
    monkeypatch.setattr(agent_markdown,'markdown_document',refuse)
    async def call(method='GET',tag=None):
        counts.calls.clear();loads.clear()
        response=await routes.handle(request(method=method,headers={'If-None-Match':tag} if tag else {}),cx)
        assert len(counts.calls)<=16
        assert sum(sql.startswith('SELECT l.*, i.created_at FROM live') for sql in counts.calls)==(0 if tag else 1)
        assert len(loads)==(0 if tag else 1)
        if tag:
            assert len(counts.calls)<=3
        return response
    response=await call()
    from server.app import agent_traffic
    await agent_traffic.settle(counts)
    body=response.body.decode()
    assert response.status_code==200 and body.startswith('# Published title\n\nApproved description\n\n')
    assert all(text not in body for text in ['PENDING_TITLE_CANARY','Body only marker','Different visible heading'])
    assert len([line for line in body.splitlines() if line.startswith('- [')])==min(n+2,50)
    assert '- [All entries](<'+ORIGIN+'/archive/index.md>)\n' in body
    for method in ['GET','HEAD']:
        repeated=await call(method,response.headers['etag'])
        assert repeated.status_code==304 and repeated.body==b'' and repeated.headers['etag']==response.headers['etag']

async def test_af_ll1_access_and_publication(db,monkeypatch):
    await seed(db,2)
    cx=routes.Context(db,'',None)
    first=await routes.handle(request(),cx)
    tag=first.headers['etag']
    for headers in [{'Cookie':'__Host-sk_owner=invalid'},{'Cookie':'__Host-sk_reader=invalid'},{'Authorization':'Bearer invalid'}]:
        response=await routes.handle(request(headers={**headers,'If-None-Match':tag}),cx)
        assert response.status_code==200 and response.headers['cache-control']=='private, no-store, no-transform' and 'etag' not in response.headers
    await db.execute("DELETE FROM live WHERE kind='entry'")
    removed=await routes.handle(request(headers={'If-None-Match':tag}),cx)
    assert removed.status_code==200 and '/journal/page-' not in removed.body.decode()
    updated=await content.update_item(db,ACTOR,'site',2,{'private':True})
    await approvals.publish_now(db,[{'id':'site','version':updated['version']}],'',ORIGIN)
    async def refuse(*args,**kwargs):
        pytest.fail('private gate must run before the view')
    monkeypatch.setattr(site,'live_view',refuse)
    for method in ['GET','HEAD']:
        response=await routes.handle(request(method=method,headers={'If-None-Match':tag}),cx)
        assert response.status_code==404 and response.body==(b'' if method=='HEAD' else SIGN_IN.encode()) and 'etag' not in response.headers

async def test_af_ll1_archive_query_shape(db,monkeypatch):
    await seed(db,200)
    counts=Count(db)
    loads=[];original=site.live_view
    async def load(*args,**kwargs):
        loads.append(True)
        return await original(*args,**kwargs)
    monkeypatch.setattr(site,'live_view',load)
    response=await routes.handle(request('/archive/'),routes.Context(counts,'',None))
    assert response.status_code==200 and len(loads)<=2 and len(counts.calls)<=24
