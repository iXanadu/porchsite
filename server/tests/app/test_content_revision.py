"""The exact epoch witness, paired with content-revision.test.ts."""
import json
from pathlib import Path
from unittest.mock import AsyncMock
import pytest
import pytest_asyncio
from server.app import content_revision as revision, public_read, content, approvals
from server.app.db import apply_schema, MIGRATIONS
from .conftest import TABLES

FIXTURE=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/content-revision.json').read_text())

@pytest_asyncio.fixture(autouse=True)
async def clean_revision(db):
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')

async def pair(db):
    return json.loads(await revision.read_revision(db))

async def site(db):
    item=await content.create_item(db,'assistant:test','site',{'title':'Before witness','theme':'personal-homepage'},None)
    await approvals.publish_now(db,[{'id':item['id'],'version':item['version']}],'','https://site.example')
    return item

def test_canonical_values():
    for value in FIXTURE['counter_valid']:assert revision.canonical_counter(value)
    for value in FIXTURE['counter_invalid']:assert not revision.canonical_counter(value)
    assert revision.canonical_epoch(FIXTURE['epoch_valid'])
    for value in FIXTURE['epoch_invalid']:assert not revision.canonical_epoch(value)

@pytest.mark.parametrize('row',FIXTURE['tables'],ids=lambda row:row['table'])
async def test_all_events_and_columns(db,row):
    table=row['table'];epoch,n=await pair(db)
    await db.execute(row['insert']);assert await pair(db)==[epoch,str(int(n)+1)]
    columns=await db.fetch("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",table)
    for column in columns:
        name=column['column_name'];assert name.replace('_','').isalpha()
        epoch,n=await pair(db);await db.execute(f'UPDATE {table} SET {name}={name}')
        assert await pair(db)==[epoch,str(int(n)+1)]
    epoch,n=await pair(db);await db.execute(f'DELETE FROM {table}');assert await pair(db)==[epoch,str(int(n)+1)]
    epoch,n=await pair(db);await db.execute(f'TRUNCATE {table}')
    assert await pair(db)==[epoch,str(int(n)+1)]

async def test_delete_overflow_and_rollback(db):
    old=await pair(db);await db.execute('DELETE FROM content_revision')
    assert await revision.read_revision(db) is None
    await db.execute('INSERT INTO private_approvals(version) VALUES(7)');fresh=await pair(db)
    assert fresh[0]!=old[0] and fresh[1]=='1'
    await db.execute('UPDATE content_revision SET n=9223372036854775807')
    await db.execute('UPDATE private_approvals SET version=version');rotated=await pair(db)
    assert rotated[0]!=fresh[0] and rotated[1]=='1'
    with pytest.raises(Exception):
        async with db.acquire() as connection,connection.transaction():
            await connection.execute('INSERT INTO private_approvals(version) VALUES(8)')
            await connection.execute('INSERT INTO private_approvals(version) VALUES(7)')
    assert await pair(db)==rotated
    assert await db.fetchval('SELECT count(*) FROM private_approvals WHERE version=8')==0
    before=await pair(db);await db.execute('INSERT INTO private_approvals(version) VALUES(7) ON CONFLICT(version) DO UPDATE SET version=excluded.version')
    after=await pair(db);assert after[0]==before[0] and int(after[1])>int(before[1])

async def test_identity_and_independent_late_read(db,http,monkeypatch):
    await site(db);original=revision.read_revision;original_initial=revision.initial_facts
    async def plain(binding):return await public_read.facts(binding),None
    monkeypatch.setattr(revision,'initial_facts',plain)
    legacy=await http.get('/')
    reader=AsyncMock(side_effect=original);facts=AsyncMock(side_effect=public_read.facts)
    initial=AsyncMock(side_effect=original_initial)
    monkeypatch.setattr(revision,'initial_facts',initial)
    monkeypatch.setattr(revision,'read_revision',reader);monkeypatch.setattr(public_read,'facts',facts)
    response=await http.get('/')
    assert response.content==legacy.content and response.headers==legacy.headers
    assert facts.call_count==0 and initial.call_count==1 and reader.call_count==1
    facts.reset_mock();initial.reset_mock();reader.reset_mock()
    head=await http.head('/',headers={'If-None-Match':response.headers['etag']})
    assert head.status_code==304 and head.content==b'' and facts.call_count==0 and initial.call_count==1 and reader.call_count==1

async def test_equal_counter_different_epoch_late_edit(db,http,monkeypatch):
    await site(db);await db.execute('UPDATE content_revision SET n=1');before=await pair(db)
    original=revision.read_revision;calls=0
    async def changing(binding):
        nonlocal calls
        calls+=1
        if calls==1:
            await db.execute('DELETE FROM content_revision')
            await db.execute("UPDATE live SET data=jsonb_set(data::jsonb,'{title}','\"After witness\"')::text WHERE item_id='site'")
        return await original(binding)
    monkeypatch.setattr(revision,'read_revision',changing)
    response=await http.get('/')
    assert response.status_code==200 and 'After witness' in response.text and 'Before witness' not in response.text
    after=await pair(db);assert after[1]==before[1] and after[0]!=before[0]

async def test_missing_final_pair_uses_fresh_facts(db,http,monkeypatch):
    await site(db);original=revision.read_revision;calls=0
    async def changing(binding):
        nonlocal calls
        calls+=1
        if calls==1:await db.execute('DELETE FROM content_revision')
        return await original(binding)
    facts=AsyncMock(side_effect=public_read.facts);monkeypatch.setattr(public_read,'facts',facts)
    monkeypatch.setattr(revision,'read_revision',changing)
    response=await http.get('/')
    assert response.status_code==200 and facts.call_count==1 and await revision.read_revision(db) is None

async def test_credentials_bypass_witness(db,http,monkeypatch):
    await site(db);reader=AsyncMock(side_effect=AssertionError('out-of-scope witness'))
    initial=AsyncMock(side_effect=AssertionError('out-of-scope initial witness'))
    monkeypatch.setattr(revision,'initial_facts',initial)
    monkeypatch.setattr(revision,'read_revision',reader)
    for headers in [{'authorization':''},{'cookie':'__Host-sk_owner=expired'},{'cookie':'__Host-sk_reader=invalid'}]:
        await http.get('/',headers=headers)
    assert reader.call_count==0 and initial.call_count==0

async def test_failed_reentry_restores_complete_installed_state(db):
    before=await pair(db);await apply_schema(db);assert await pair(db)==before
    async with db.acquire() as connection:
        with pytest.raises(Exception):
            async with connection.transaction():
                for row in FIXTURE['tables']:
                    for suffix in ['row','truncate']:
                        await connection.execute(f"DROP TRIGGER content_revision__{row['table']}__{suffix} ON {row['table']}")
                await connection.execute('DROP FUNCTION advance_content_revision()')
                await connection.execute('DROP TABLE content_revision')
                sql=next(sql for name,sql in MIGRATIONS if name=='0021_content_revision')
                await connection.execute(sql)
                await connection.execute('CREATE TABLE witness_fault(id INTEGER PRIMARY KEY)')
                await connection.execute('INSERT INTO witness_fault VALUES(1)')
                await connection.execute('INSERT INTO witness_fault VALUES(1)')
    assert await pair(db)==before
    assert await db.fetchval("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'content_revision__%' AND NOT tgisinternal")==20
    assert await db.fetchval("SELECT to_regclass('witness_fault')") is None

async def test_enabled_modes_never_pay_witness(db,http,app,monkeypatch):
    from dataclasses import replace
    await site(db);tag=(await http.get('/')).headers['etag']
    reader=AsyncMock(side_effect=AssertionError('out-of-scope witness'))
    initial=AsyncMock(side_effect=AssertionError('out-of-scope initial witness'))
    monkeypatch.setattr(revision,'initial_facts',initial)
    monkeypatch.setattr(revision,'read_revision',reader)
    for artifacts,responses in [(True,False),(False,True),(True,True)]:
        app.settings=replace(app.settings,site_url='https://site.example',public_artifacts=artifacts,public_responses=responses)
        response=await http.get('/',headers={'If-None-Match':tag})
        assert response.status_code==304
    assert reader.call_count==0 and initial.call_count==0

async def test_invalid_row_snapshot_and_capability():
    good=dict(epoch=FIXTURE['epoch_valid'],epoch_storage='uuid',n='9007199254740993',storage='bigint')
    for rows in [[],[good,good],[{**good,'epoch':''}],[{**good,'n':'01'}],[{**good,'storage':'text'}],[{**good,'epoch_storage':'text'}]]:
        class Binding:
            async def fetch(self,sql):
                assert sql==revision.REVISION_SQL
                return rows
        assert await revision.read_revision(Binding()) is None
    class Broken:
        async def fetch(self,sql):raise RuntimeError('unavailable')
    assert await revision.read_revision(Broken()) is None

async def test_clock_crossing_still_discards_the_old_render(db,http,monkeypatch):
    from datetime import datetime,UTC
    item=await site(db)
    item=await content.update_item(db,'assistant:test','site',item['version'],{'timezone':'UTC','notice':{'text':'Boundary notice','until':'2030-01-01'}})
    await approvals.publish_now(db,[{'id':item['id'],'version':item['version']}],'','https://site.example')
    now=datetime(2030,1,1,23,59,30,tzinfo=UTC).timestamp()
    monkeypatch.setattr(public_read.time,'time',lambda:now)
    original=revision.read_revision;calls=0
    async def changing(binding):
        nonlocal now,calls
        calls+=1
        if calls==1:now+=60
        return await original(binding)
    monkeypatch.setattr(revision,'read_revision',changing)
    response=await http.get('/')
    assert response.status_code==200 and 'Boundary notice' not in response.text


async def test_combined_snapshot_preserves_owned_raw_tuples(db):
    await site(db);plain=await public_read.facts(db,True)
    combined,p=await revision.initial_facts(db)
    assert combined==plain and p==await revision.read_revision(db)
    rows=[dict(row) for row in await db.fetch(public_read.FACTS_SQL)]
    good=dict(category=revision.WITNESS_CATEGORY,ident='epoch-counter-v1',value=json.dumps([FIXTURE['epoch_valid'],'uuid','9007199254740993','bigint']))
    for metadata in [[],[good,good],[{**good,'ident':'wrong'}],[{**good,'value':'bad'}],[{**good,'value':json.dumps([FIXTURE['epoch_valid'],'uuid','01','bigint'])}]]:
        f,token=revision.initial_snapshot([*rows,*metadata])
        assert token is None and f==plain
    f,token=revision.initial_snapshot([*rows,rows[0],good])
    assert token is not None and f['raw']==[[x['category'],x['ident'],x['value']] for x in [*rows,rows[0]]]
    assert public_read.view_proof(combined)==public_read.view_proof(plain)


async def test_initial_failure_falls_back_only_on_known_absence(db):
    await site(db);rows=await db.fetch(public_read.FACTS_SQL);calls=[]
    class Absent(Exception):sqlstate='42P01'
    class Binding:
        async def fetch(self,sql):
            calls.append(sql)
            if sql==revision.initial_sql():raise Absent('relation "content_revision" does not exist')
            return rows
    f,token=await revision.initial_facts(Binding())
    assert token is None and f==await public_read.facts(db)
    assert calls==[revision.initial_sql(),public_read.FACTS_SQL]
    class Broken:
        async def fetch(self,sql):raise RuntimeError('disk I/O error')
    with pytest.raises(RuntimeError,match='disk I/O error'):await revision.initial_facts(Broken())
