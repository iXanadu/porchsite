"""AG Slice A; paired with native Worker read-keys tests."""
import json,re
import pytest
from server.app import read_keys as read,keys,content,approvals,published_read,mcp
from .conftest import TABLES
from .web import signed_in
ORIGIN='https://site.example'
@pytest.fixture(autouse=True)
async def clear(db):
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    await db.execute('UPDATE auth_state SET owner_epoch=0 WHERE id=1')
async def rpc(http,token,method,params=None,fallback=False):
    r=await http.post('/mcp',json={'jsonrpc':'2.0','id':1,'method':method,'params':{**(params or {}),**({'_meta':{'test':True}} if fallback else {})}},headers={'Authorization':'Bearer '+token,'Accept':'application/json' if fallback else 'application/json, text/event-stream'})
    return r,r.json()
async def fixture(db):
    one=await content.create_item(db,'assistant:test','site',{'title':'Published title'},None)
    await approvals.publish_now(db,[{'id':'site','version':one['version']}],'',ORIGIN)
    await content.update_item(db,'assistant:test','site',one['version'],{'title':'DRAFT SENTINEL'})
async def test_ag_key_prefix_new_table(db):
    made=await read.create(db,'Reader')
    assert re.fullmatch(r'prk_[A-Za-z0-9_-]{32}',made['token'])
    assert await keys.lookup(db,made['token']) is None
    props=await read.lookup(db,made['token'])
    assert props['scope']=='published_read' and made['token'] not in json.dumps(await read.list(db))
    await db.execute('UPDATE auth_state SET owner_epoch=owner_epoch+1 WHERE id=1')
    assert await read.lookup(db,made['token']) is None and not await read.valid(db,props)
async def test_ag_revoke_immediate(db):
    made=await read.create(db,'Reader');props=await read.lookup(db,made['token'])
    await read.revoke(db,made['id']);await read.revoke(db,made['id'])
    assert await read.lookup(db,made['token']) is None and not await read.valid(db,props)
    assert len([e for e in await read.events(db) if e['kind']=='revoked'])==1
    assert made['token'] not in json.dumps(await read.events(db))
    other=await read.create(db,'Other')
    await db.execute("CREATE FUNCTION fail_read_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='revoked' THEN RAISE EXCEPTION 'audit failure'; END IF; RETURN NEW; END $$")
    await db.execute('CREATE TRIGGER fail_read_audit BEFORE INSERT ON agent_read_key_events FOR EACH ROW EXECUTE FUNCTION fail_read_audit()')
    try:
        with pytest.raises(Exception):await read.revoke(db,other['id'])
        assert await read.lookup(db,other['token']) is not None
    finally:await db.execute('DROP TRIGGER fail_read_audit ON agent_read_key_events;DROP FUNCTION fail_read_audit()')
@pytest.mark.parametrize('fallback',[False,True])
async def test_ag_tools_enforced(db,http,fallback):
    await fixture(db);made=await read.create(db,'Reader')
    _,init=await rpc(http,made['token'],'initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'test','version':'1'}},fallback)
    assert init['result']['instructions']==read.INSTRUCTIONS
    _,listed=await rpc(http,made['token'],'tools/list',fallback=fallback)
    names=[t['name'] for t in listed['result']['tools']]
    assert 'site_state' in names and set(names)<=read.ALLOWED
    before=await db.fetchval('SELECT count(*) FROM items')
    for name,args in [('item_create',{'kind':'note','data':{'text':'WRONG','date':'2026-10-17'}}),('approval_request',{'ids':['site'],'note':''}),('image_add',{'data':'not-image'}),('site_stats',{}),('item_history',{'id':'site'})]:
        _,out=await rpc(http,made['token'],'tools/call',{'name':name,'arguments':args},fallback)
        assert out.get('error') or out.get('result',{}).get('isError')
    assert await db.fetchval('SELECT count(*) FROM items')==before
    response,out=await rpc(http,made['token'],'tools/call',{'name':'site_state','arguments':{'guide':{}}},fallback)
    assert 'DRAFT SENTINEL' not in json.dumps(out)
    assert json.loads(out['result']['content'][0]['text'])['site']['title']=='Published title'
    assert response.headers['cache-control']=='private, no-store, no-transform'
    _,refused=await rpc(http,made['token'],'tools/call',{'name':'site_state','arguments':{'full':True}},fallback)
    assert refused['result']['isError']
    await read.revoke(db,made['id'])
    response,_=await rpc(http,made['token'],'tools/list',fallback=fallback)
    assert response.status_code==401
async def test_ag_revocation_delivery_race(db,monkeypatch):
    await fixture(db);made=await read.create(db,'Reader');props={**await read.lookup(db,made['token']),'origin':ORIGIN}
    original=published_read.state
    async def barrier(*args,**kwargs):
        value=await original(*args,**kwargs)
        await read.revoke(db,made['id'])
        return value
    monkeypatch.setattr(published_read,'state',barrier)
    result=await mcp._call(db,'site_state',{},props,'test')
    assert result.is_error and 'Published title' not in result.content[0].text
async def test_ag_key_issue_once(db,http):
    cookies=await signed_in(db)
    page=(await http.get('/review/assistants',cookies=cookies)).text
    csrf=re.search(r'name="csrf" value="([^"]+)"',page).group(1)
    made=await http.post('/review/assistants',cookies=cookies,data={'csrf':csrf,'key_name':'Reader','make_key':'1','read_only':'1'})
    key=re.search(r'prk_[A-Za-z0-9_-]{32}',made.text).group(0)
    assert 'no-store' in made.headers['cache-control']
    after=(await http.get('/review/assistants',cookies=cookies)).text
    assert key not in after and 'Read only — published pages' in after
    assert (await http.post('/mcp?key='+key,json={})).status_code==401

async def test_ag_key_issue_atomic(db):
    made=await read.create(db,'Reader')
    with pytest.raises(Exception):await content.create_item(db,'assistant:test','note',{'text':made['token'],'date':'2026-10-17'},None)
    with pytest.raises(Exception):await read.create(db,made['token'])
    await db.execute("CREATE FUNCTION fail_read_create() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='created' THEN RAISE EXCEPTION 'audit failure'; END IF; RETURN NEW; END $$")
    await db.execute('CREATE TRIGGER fail_read_create BEFORE INSERT ON agent_read_key_events FOR EACH ROW EXECUTE FUNCTION fail_read_create()')
    try:
        with pytest.raises(Exception):await read.create(db,'Failure')
        assert await db.fetchval("SELECT count(*) FROM agent_read_keys WHERE name='Failure'")==0
    finally:await db.execute('DROP TRIGGER fail_read_create ON agent_read_key_events;DROP FUNCTION fail_read_create()')
    await db.execute("UPDATE agent_read_keys SET expires_at='2000-01-01' WHERE id=$1",made['id'])
    assert await read.lookup(db,made['token']) is None

async def test_ag_owner_issue_fenced(db):
    from starlette.requests import Request
    cookies=await signed_in(db)
    request=Request({'type':'http','method':'POST','path':'/review/assistants','headers':[(b'cookie','; '.join(k+'='+v for k,v in cookies.items()).encode())]})
    await db.execute('UPDATE auth_state SET owner_epoch=owner_epoch+1 WHERE id=1')
    with pytest.raises(Exception):await read.create(db,'Fenced',req=request)
    assert await db.fetchval('SELECT count(*) FROM agent_read_keys')==0
    assert await read.events(db)==[]
    made=await read.create(db,'New owner')
    with pytest.raises(Exception):await read.revoke(db,made['id'],req=request)
    assert await read.lookup(db,made['token']) is not None
