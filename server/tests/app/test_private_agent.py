"""AG-4/5, paired with the Worker private-agent tests."""
import re
import pytest
from server.app import content,approvals,read_keys,private_agent,public_artifacts,site
from server.app.privacy import BLANK,SIGN_IN
from .conftest import TABLES
from .web import signed_in,session_hash
ORIGIN='https://site.example'
@pytest.fixture(autouse=True)
async def clean(db):
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    await db.execute("UPDATE auth_state SET owner_epoch=0,private_floor='' WHERE id=1")
async def fixture(db):
    item=await content.create_item(db,'assistant:test','site',{'title':'Private handbook','private':True,'streams':[{'id':'guide','title':'Guides','dated_addresses':False}],'archive':{'enabled':True,'title':'All pages'}},None)
    entry=await content.create_item(db,'assistant:test','entry',{'stream':'guide','title':'Published guide','date':'2026-10-17','body':'Visible private prose.','tags':['report']},None)
    await approvals.publish_now(db,[{'id':'site','version':item['version']},{'id':entry['id'],'version':entry['version']}],'',ORIGIN)
    await content.update_item(db,'assistant:test',entry['id'],entry['version'],{'body':'DRAFT SECRET'})
    key=await read_keys.create(db,'Read key');second=await read_keys.create(db,'Other key')
    await signed_in(db,'owner-one');await signed_in(db,'owner-two')
    await db.execute("INSERT INTO readers(id,name,created_at) VALUES('reader','Reader','2026-10-17')")
    await db.execute("INSERT INTO reader_passkeys(id,reader_id,public_key,created_at) VALUES('credential','reader',$1,'2026-10-17')",b'\x01')
    await db.execute("INSERT INTO reader_sessions(token_hash,reader_id,credential_id,epoch,created_at,expires_at) VALUES($1,'reader','credential',0,'2026-10-17','2099-01-01')",session_hash('reader-one'))
    return {'item':item,'entry':entry,'key':key,'second':second,'auth':{'Authorization':'Bearer '+key['token']},'owner':{'Cookie':'__Host-sk_owner=owner-one'},'reader':{'Cookie':'__Host-sk_reader=reader-one'}}
def blank(r,head=False):
    assert r.status_code==404 and r.text==('' if head else SIGN_IN if 'authorization' not in r.request.headers else BLANK)
    assert r.headers['cache-control']=='private, no-store, no-transform'
    assert not any(h in r.headers for h in ('etag','last-modified','link','vary','age','location'))
async def test_ag_private_gate_first(db,http,monkeypatch):
    f=await fixture(db)
    async def forbidden(*args,**kwargs):raise AssertionError('view before auth')
    monkeypatch.setattr(site,'live_view',forbidden)
    for headers in ({},{'Authorization':'Bearer unknown'},{**f['owner'],'Authorization':'Bearer unknown'},{'Cookie':'__Host-sk_owner=expired'},{'Authorization':'Bearer psk_unknown'}):
        for path in ('/','/index.md','/llms.txt','/guide/published-guide/index.md','/missing/index.md'):
            for method in ('GET','HEAD'):blank(await http.request(method,path,headers={**headers,'Accept':'text/markdown','If-None-Match':'*'}),method=='HEAD')
async def test_ag_bearer_html_published_cache(db,http):
    f=await fixture(db)
    for path in ('/','/guide/published-guide/','/archive/?stream=guide&tag=report'):
        reader=await http.get(path,headers=f['reader'])
        for method in ('GET','HEAD'):
            r=await http.request(method,path,headers={**f['auth'],'If-None-Match':'*'})
            assert r.status_code==200 and r.text==('' if method=='HEAD' else reader.text)
            assert r.headers['cache-control']=='private, no-store, no-transform'
            assert not any(h in r.headers for h in ('etag','last-modified','content-signal'))
    for path in ('/review','/media/00000000000000000000000000000000.jpg','/sitemap.xml','/guide/feed.xml'):blank(await http.get(path,headers=f['auth']))
    assert await db.fetchval('SELECT count(*) FROM public_artifacts')==0
async def test_ag_private_markdown_identity_map_conditionals(db,http):
    f=await fixture(db);tags=set();first_tag=''
    for headers in (f['auth'],f['owner'],f['reader'],{'Authorization':'Bearer '+f['second']['token']},{'Cookie':'__Host-sk_owner=owner-two'}):
        direct=await http.get('/guide/published-guide/index.md',headers=headers);body=direct.text;tag=direct.headers['etag'];tags.add(tag)
        if first_tag:assert (await http.get('/guide/published-guide/index.md',headers={**headers,'If-None-Match':first_tag})).status_code==200
        else:first_tag=tag
        assert 'Visible private prose' in body and 'DRAFT SECRET' not in body and '/review' not in body
        assert direct.headers['cache-control']==private_agent.PRIVATE_LIGHT and re.fullmatch(r'W/"ag-sha256-[a-f0-9]{64}"',tag)
        negotiated=await http.get('/guide/published-guide/',headers={**headers,'Accept':'text/markdown'})
        assert negotiated.text==body and negotiated.headers['etag']==tag and negotiated.headers['vary']=='Accept' and 'vary' not in direct.headers
        head=await http.head('/guide/published-guide/index.md',headers=headers)
        assert head.text=='' and dict(head.headers)==dict(direct.headers) and int(head.headers['content-length'])==len(body.encode())
        for match in (tag,tag.removeprefix('W/'),'*'):
            r=await http.get('/guide/published-guide/index.md',headers={**headers,'If-None-Match':match})
            assert r.status_code==304 and r.text=='' and r.headers['cache-control']==private_agent.PRIVATE_LIGHT
        foreign=await http.get('/guide/published-guide/index.md',headers={**headers,'If-None-Match':'W/"sha256-foreign"','If-Modified-Since':'Wed, 01 Jan 2099 00:00:00 GMT'})
        assert foreign.status_code==200
        result=await http.get('/llms.txt',headers=headers)
        assert all(s in result.text for s in ('/index.md','/archive/index.md','/guide/published-guide/index.md'))
        assert '/review' not in result.text and f['key']['token'] not in result.text and result.headers['cache-control']==private_agent.PRIVATE_LIGHT
    assert len(tags)==5 and await db.fetchval('SELECT count(*) FROM public_artifacts')==0 and await db.fetchval('SELECT count(*) FROM agent_traffic_daily')==0
async def test_ag_private_revoke_expire_epoch(db,http):
    f=await fixture(db);first=await http.get('/index.md',headers=f['auth']);tag=first.headers['etag']
    await read_keys.revoke(db,f['key']['id']);blank(await http.get('/index.md',headers={**f['auth'],'If-None-Match':tag}))
    await db.execute('UPDATE auth_state SET owner_epoch=owner_epoch+1 WHERE id=1')
    blank(await http.get('/llms.txt',headers=f['owner']));blank(await http.get('/index.md',headers={'Authorization':'Bearer '+f['second']['token']}))
    await db.execute('UPDATE readers SET revoked=1');blank(await http.get('/index.md',headers=f['reader']))
    robots=await http.get('/robots.txt',headers={**f['auth'],'If-None-Match':'*'})
    assert robots.text=='User-agent: *\nDisallow: /\n' and 'etag' not in robots.headers
@pytest.mark.parametrize('change',['revoke','unpublish'])
async def test_ag_private_delivery_races(db,http,monkeypatch,change):
    f=await fixture(db);original=public_artifacts.snapshot;calls=0
    async def barrier(*args):
        nonlocal calls
        stamp=await original(*args);calls+=1
        if calls==1:
            if change=='revoke':await read_keys.revoke(db,f['key']['id'])
            else:await db.execute('DELETE FROM live WHERE item_id=$1',f['entry']['id'])
        return stamp
    monkeypatch.setattr(public_artifacts,'snapshot',barrier)
    # private_agent imports the function directly, so stall that exact call site.
    monkeypatch.setattr(private_agent,'snapshot',barrier)
    r=await http.get('/guide/published-guide/index.md',headers=f['auth'])
    assert r.status_code==404 and 'Visible private prose' not in r.text and 'etag' not in r.headers

async def test_ag_private_negotiation_filtered_identity(db,http):
    f=await fixture(db)
    a=await http.get('/archive/index.md?sort=date&tag=report&stream=guide',headers=f['auth'])
    b=await http.get('/archive/?stream=guide&tag=report',headers={**f['auth'],'Accept':'text/markdown'})
    assert a.status_code==200 and a.text==b.text and a.headers['etag']==b.headers['etag']
    for path in ('/archive/?invalid=value','/archive/index.md?tag=report&tag=other'):
        r=await http.get(path,headers={**f['auth'],'Accept':'text/markdown'})
        assert r.status_code==400 and 'etag' not in r.headers
        blank(await http.get(path,headers={'Authorization':'Bearer unknown','Accept':'text/markdown'}))
    refusal=await http.get('/',headers={**f['auth'],'Accept':'text/html;q=0,text/markdown;q=0'})
    assert refusal.status_code==406 and refusal.headers['vary']=='Accept' and 'etag' not in refusal.headers
    assert (await http.get('/index.md',headers={**f['auth'],'Accept':'application/json'})).status_code==200
    await db.execute("UPDATE agent_read_keys SET expires_at='2000-01-01' WHERE id=$1",f['key']['id'])
    blank(await http.get('/index.md',headers={**f['auth'],'If-None-Match':'*'}))

async def test_ag_private_visible_validator_input(db,http):
    f=await fixture(db)
    await db.execute("UPDATE live SET published_at='2026-10-17T10:00:00.000Z'")
    before={}
    for path in ('/index.md','/llms.txt'):
        r=await http.get(path,headers=f['auth'])
        assert r.status_code==200
        before[path]=(r.text,r.headers['etag'])
    for kind,data in (('card',{'name':'HIDDEN CARD','description':'Hidden private description','visibility':'private'}),('entry',{'stream':'guide','title':'HIDDEN STATUS','date':'2026-10-17','status':'draft','body':'Hidden status prose'})):
        item=await content.create_item(db,'assistant:test',kind,data,None)
        await approvals.publish_now(db,[{'id':item['id'],'version':item['version']}],'',ORIGIN)
        await db.execute("UPDATE live SET published_at='2031-01-01T00:00:00.000Z' WHERE item_id=$1",item['id'])
    for path,(body,tag) in before.items():
        r=await http.get(path,headers=f['auth'])
        assert r.text==body and r.headers['etag']==tag
        assert (await http.get(path,headers={**f['auth'],'If-None-Match':tag})).status_code==304
