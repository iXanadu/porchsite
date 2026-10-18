"""The Worker lifetime detail keeps the existing paired image_add contract."""
import json
from pathlib import Path
from server.app import oauth
from .web import Mcp

CASES = json.loads((Path(__file__).resolve().parents[3] / 'spec' / 'upload-input-lifetime.json').read_text())

async def test_upload_input_lifetime_paired_responses(db, http):
    assistant = Mcp(http, await oauth.mint(db, 'Fixture', 'https://site.example'))
    for case in CASES:
        before = [dict(row) for row in await db.fetch('SELECT name,size,width,height FROM media ORDER BY name')]
        error, value, _ = await assistant.call('image_add', **case['args'])
        if 'error' in case:
            assert error and value['error'] == case['error'], case['name']
            assert [dict(row) for row in await db.fetch('SELECT name,size,width,height FROM media ORDER BY name')] == before
        else:
            assert not error, (case['name'], value)
            images = value['images'] if case['batch'] else [{k:value[k] for k in ('image','width','height')}]
            assert images == case['images'], case['name']
            assert bool('images' in value) == case['batch']
            assert isinstance(value['next'], str) and value['next']

async def test_upload_input_lifetime_waits_for_the_complete_body(db, http):
    import asyncio
    assistant = Mcp(http, await oauth.mint(db, 'Fixture', 'https://site.example'))
    body = json.dumps({'jsonrpc':'2.0','id':17,'method':'tools/call','params':{'name':'image_add','arguments':CASES[0]['args']}}).encode()
    started, finish = asyncio.Event(), asyncio.Event()
    async def chunks():
        yield body[:-8]
        started.set()
        await finish.wait()
        yield body[-8:]
    before = [dict(row) for row in await db.fetch('SELECT name FROM media ORDER BY name')]
    pending = asyncio.create_task(http.post('/mcp', content=chunks(), headers=assistant.headers))
    try:
        await started.wait()
        assert not pending.done()
        assert [dict(row) for row in await db.fetch('SELECT name FROM media ORDER BY name')] == before
    finally:
        finish.set()
    response = await pending
    assert response.status_code == 200
    assert not response.json()['result'].get('isError')
