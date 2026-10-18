"""Recovery transport, paired with recovery-links.test.ts."""
import json
from pathlib import Path
import pytest
import pytest_asyncio
from starlette.requests import Request
from server.app import owner,routes,cli
from .web import claimed
FIXTURE=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/recovery-links.json').read_text())

@pytest_asyncio.fixture(autouse=True)
async def recovery_owner(db):
    for t in ['recovery_codes','challenges','passkeys','sessions','owner']:
        await db.execute('DELETE FROM '+t)
    await claimed(db)

async def test_html_dom_fill_and_post_only(db,http):
    from urllib.parse import quote
    code='credential-canary-\"><script>'
    for suffix in ['#code='+quote(code),'?code='+quote(code),'']:
        r=await http.get('/recover'+suffix)
        assert r.status_code==200 and code not in r.text
        assert FIXTURE['script'] in r.text
        assert '<form method="post" action="/recover/options">' in r.text
        assert r.text.index('history.replaceState')<r.text.index('await fetch(')
        assert r.headers['referrer-policy']=='no-referrer' and r.headers['cache-control']=='no-store'
    r=await http.head('/recover?code=canary')
    assert r.status_code==200 and r.content==b''

async def test_body_credentials_and_hashed_storage(db,http):
    code='recovery-code-with-24-random-bytes-test'
    await owner.issue_recovery_code(db,code)
    h=await db.fetchval('SELECT code_hash FROM recovery_codes')
    assert len(h)==43 and h!=code
    for kwargs in [{'json':{'code':code}},{'data':{'code':code}}]:
        r=await http.post('/recover/options',**kwargs)
        assert r.status_code==200,r.text
        assert code not in r.text
    r=await http.post('/recover/options?code='+code,json={})
    assert r.status_code==403 and code not in r.text
    assert await db.fetchval('SELECT count(*) FROM recovery_codes')==1

async def test_json_errors_do_not_echo(db,http):
    for path in ['/recover/options','/recover/verify']:
        for body in ['{"code":"private-canary','null','[]']:
            r=await http.post(path,content=body,headers={'content-type':'application/json'})
            assert r.status_code==403 and 'private-canary' not in r.text
            assert r.headers['referrer-policy']=='no-referrer' and r.headers['cache-control']=='no-store'

async def test_independent_cutoff_and_unclaimed_precedence(db,http,monkeypatch):
    for query in FIXTURE['query_cases']:
        for method in ['GET','HEAD']:
            req=Request({'type':'http','method':method,'scheme':'https','server':('site.example',443),'path':'/recover','query_string':query[1:].encode(),'headers':[]})
            assert routes.recovery_query_refusal(req) is None
            r=routes.recovery_query_refusal(req,False)
            assert r.status_code==400
            assert r.headers['referrer-policy']=='no-referrer' and r.headers['cache-control']=='no-store'
            if method=='HEAD':assert r.body==b''
            else:assert json.loads(r.body)=={'error':'code_in_url','message':FIXTURE['cutoff_message']}
    monkeypatch.setattr(routes,'RECOVERY_QUERY_COMPAT',False)
    for method in ['GET','HEAD']:
        r=await http.request(method,'/recover?%63ode=canary')
        assert r.status_code==400 and 'canary' not in r.text
    await db.execute('DELETE FROM owner')
    for method in ['GET','HEAD']:
        r=await http.request(method,'/recover?code=unclaimed-canary')
        assert r.status_code==409 and 'unclaimed-canary' not in r.text

async def test_cli_fragment_issuer(db,test_dsn):
    link,expiry=await cli.recovery_link(test_dsn,'https://example.com',24)
    from urllib.parse import urlsplit,parse_qs
    import base64
    u=urlsplit(link)
    assert u.path=='/recover' and not u.query
    code=parse_qs(u.fragment)['code'][0]
    assert len(base64.urlsafe_b64decode(code+'='*(-len(code)%4)))==24
    assert await db.fetchval('SELECT code_hash FROM recovery_codes')==owner.hash_token(code)
    assert expiry>owner.now()
