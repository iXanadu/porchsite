"""AI-5's sole discovery delta and unchanged restricted authority."""
import hashlib
import json
from pathlib import Path
import pytest
from server.app import keys,read_keys,mcp
from .conftest import TABLES
from .web import Mcp
FACTS=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/capability-facts.json').read_text())
CONTRACT=json.loads(Path(__file__).with_name('cloudflare_tools.json').read_text())
@pytest.fixture(autouse=True)
async def clear(db):
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    await db.execute('UPDATE auth_state SET owner_epoch=0 WHERE id=1')
@pytest.mark.parametrize('extras',[False,True])
async def test_ai5_writer_exact_prefix_only_catalog_delta(db,http,extras):
    a=Mcp(http,(await keys.create(db,'Fixture'))['token'])
    init=(await a.rpc('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'test','version':'1'}}))['result']
    assert init['instructions']==FACTS['previous_instructions']==mcp.INSTRUCTIONS
    tools=(await a.rpc('tools/list',{'_meta':{'fixture':True}} if extras else {}))['result']['tools']
    prefix=FACTS['prefix']+'\n\n'
    assert len(prefix.encode())==FACTS['prefix_bytes']<=FACTS['max_prefix_bytes']
    theme=next(t for t in tools if t['name']=='theme_list')
    assert theme['description']==prefix+FACTS['previous_description']
    assert sum(FACTS['prefix'] in t['description'] for t in tools)==1
    theme['description']=FACTS['previous_description']
    canonical=json.dumps({'instructions':init['instructions'],'tools':tools},sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
    assert hashlib.sha256(canonical).hexdigest()==FACTS['previous_catalog_sha256']
    assert await db.fetchval('SELECT count(*) FROM items')==0
@pytest.mark.parametrize('extras',[False,True])
async def test_ai5_restricted_catalog_and_instructions_unchanged(db,http,extras):
    a=Mcp(http,(await read_keys.create(db,'Fixture'))['token'])
    init=(await a.rpc('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'test','version':'1'}}))['result']
    assert init['instructions']==read_keys.INSTRUCTIONS
    tools=(await a.rpc('tools/list',{'_meta':{'fixture':True}} if extras else {}))['result']['tools']
    assert tools==[t for t in CONTRACT['tools'] if t['name'] in FACTS['restricted_names']]
    assert sorted(t['name'] for t in tools)==sorted(FACTS['restricted_names'])
    denied=await a.rpc('tools/call',{'name':'theme_list','arguments':{}})
    assert denied.get('error') or denied['result'].get('isError')
    assert await db.fetchval('SELECT count(*) FROM items')==0
