"""The bare protocol path refuses without rendering or looking up credentials."""
import json
from pathlib import Path
from unittest.mock import AsyncMock
import pytest
from server.app import approvals,content,oauth
from .web import claimed
from .conftest import TABLES

FIXTURE=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/oauth-metadata-path.json').read_text())
CORS=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/oauth-cors.json').read_text())['headers']

@pytest.mark.parametrize('private_mode',[False,True])
async def test_oauth_metadata_path_protocol_only(db,app,http,monkeypatch,private_mode):
    await db.execute(f"TRUNCATE {TABLES} RESTART IDENTITY")
    await db.execute("UPDATE auth_state SET owner_epoch=0,private_floor='' WHERE id=1")
    await claimed(db)
    item=await content.create_item(db,'owner','site',{'title':'Hidden metadata fixture','private':private_mode},None)
    await approvals.publish_now(db,[{'id':item['id'],'version':item['version']}],'','https://site.example')
    assert (await http.get('/')).status_code == (404 if private_mode else 200)
    class NoStorage:
        def __getattr__(self,name):raise AssertionError('metadata touched storage')
    monkeypatch.setattr(app,'_pool',NoStorage())
    fetch=AsyncMock(side_effect=AssertionError('metadata performed external fetch'))
    monkeypatch.setattr(oauth,'capped_public_fetch',fetch)
    for row in FIXTURE['cases']:
        for caller in FIXTURE['origins']:
            for credential in FIXTURE['credentials']:
                headers={**credential,'If-None-Match':'*'}
                if caller is not None:headers['Origin']=caller
                response=await http.request(row['method'],row['path'],headers=headers)
                assert response.status_code == row['status']
                assert {k:v for k,v in response.headers.items()if k.startswith('access-control-')} == {k.lower():v for k,v in CORS.items()}
                assert not any(k in response.headers for k in ('location','www-authenticate','set-cookie','etag'))
                if row['status']==404 or row['method']!='GET':assert response.content == b''
                else:assert response.json()['resource']=='https://site.example/mcp'
                if row['status']==204:assert 'content-length' not in response.headers
    fetch.assert_not_awaited()
