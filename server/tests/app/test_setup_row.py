"""RA-9 claim transaction races, paired with setup-row.test.ts."""
import hashlib
import base64
from contextlib import asynccontextmanager
import pytest
from starlette.requests import Request
from server.app import owner
from server.app.errors import ApiError
from .softkey import SoftKey
from .test_web_setup_links import unclaimed
ORIGIN='https://site.example'

def request(path,cookie=''):
    return Request({'type':'http','method':'POST','scheme':'https','server':('site.example',443),'path':path,'query_string':b'','headers':[(b'host',b'site.example'),(b'cookie',cookie.encode())]})

async def begin(db,code,secret=None):
    key=SoftKey()
    opts,cookie=await owner.setup_options(db,request('/setup/options'),secret,code,'Owner')
    return request('/setup/verify',cookie.split(';')[0]),key.create(opts,ORIGIN)

async def test_hash_trim_and_single_use(db):
    await unclaimed(db)
    await owner.issue_setup_code(db,'setup-É-key')
    h=base64.urlsafe_b64encode(hashlib.sha256('setup-É-key'.encode()).digest()).decode().rstrip('=')
    assert await db.fetchval('SELECT code_hash FROM setup_codes')==h
    req,response=await begin(db,' setup-É-key ')
    assert '__Host-sk_owner=' in await owner.setup_verify(db,req,None,response)
    assert await owner.passkey_count(db)==1
    assert await db.fetchval('SELECT count(*) FROM setup_codes')==0
    with pytest.raises(ApiError,match='already has an owner'):
        await owner.issue_setup_code(db,'later')

@pytest.mark.parametrize('change',['replace','expire'])
async def test_change_after_webauthn_before_claim_transaction(db,monkeypatch,change):
    await unclaimed(db)
    await owner.issue_setup_code(db,'initial-setup-code')
    req,response=await begin(db,'initial-setup-code')
    original=owner.transaction
    calls=0
    @asynccontextmanager
    async def injected(database):
        nonlocal calls
        calls+=1
        if change=='replace':
            async with original(database) as c:
                await c.execute('DELETE FROM setup_codes')
                await c.execute('INSERT INTO setup_codes(code_hash,created_at,expires_at) VALUES($1,$2,$3)',owner.hash_token('replacement-code'),owner.now(),owner._later(hours=24))
        else:
            await database.execute("UPDATE setup_codes SET expires_at='2000-01-01T00:00:00.000Z'")
        async with original(database) as c:
            yield c
    monkeypatch.setattr(owner,'transaction',injected)
    with pytest.raises(ApiError) as error:
        await owner.setup_verify(db,req,None,response)
    assert (error.value.status,error.value.code)==(403,'code_expired')
    assert calls==1
    assert await db.fetchval('SELECT count(*) FROM owner')==0
    assert await owner.passkey_count(db)==0
    assert await db.fetchval('SELECT count(*) FROM setup_codes')==1

async def test_env_identity_and_old_challenge_format(db):
    await unclaimed(db)
    req,response=await begin(db,'old-env-code','old-env-code')
    with pytest.raises(ApiError) as error:
        await owner.setup_verify(db,req,'new-env-code',response)
    assert (error.value.status,error.value.code)==(403,'code_expired')
    req,response=await begin(db,'old-env-code','old-env-code')
    await db.execute("UPDATE challenges SET challenge=(challenge::jsonb - 'env_hash')::text")
    assert '__Host-sk_owner=' in await owner.setup_verify(db,req,'old-env-code',response)

async def test_two_valid_claims_have_one_winner(db):
    import asyncio
    await unclaimed(db)
    await owner.issue_setup_code(db,'one-owner-code')
    a=await begin(db,'one-owner-code')
    b=await begin(db,'one-owner-code')
    results=await asyncio.gather(owner.setup_verify(db,a[0],None,a[1]),owner.setup_verify(db,b[0],None,b[1]),return_exceptions=True)
    assert sum(isinstance(r,str) for r in results)==1
    errors=[r for r in results if isinstance(r,ApiError)]
    assert len(errors)==1 and (errors[0].status,errors[0].code)==(409,'claimed')
    assert await owner.passkey_count(db)==1
    assert await db.fetchval('SELECT count(*) FROM setup_codes')==0

async def test_shared_hash_vectors_and_no_plaintext_challenge(db):
    import json
    from pathlib import Path
    vectors=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/setup-code-hash.json').read_text())
    for row in vectors:
        await unclaimed(db)
        await owner.issue_setup_code(db,row['code'])
        assert await db.fetchval('SELECT code_hash FROM setup_codes')==row['code_hash']
        await owner.setup_options(db,request('/setup/options'),None,' '+row['code']+' ','Owner')
        assert row['code'] not in await db.fetchval('SELECT challenge FROM challenges')

async def test_exact_exclusive_expiry_boundary(db,monkeypatch):
    await unclaimed(db)
    fixed='2026-10-18T12:00:00.000Z'
    monkeypatch.setattr(owner,'now',lambda:fixed)
    await owner.issue_setup_code(db,'boundary-code')
    await db.execute('UPDATE setup_codes SET expires_at=$1',fixed)
    with pytest.raises(ApiError) as error:
        await owner.setup_options(db,request('/setup/options'),None,'boundary-code','Owner')
    assert (error.value.status,error.value.code)==(403,'code_expired')
