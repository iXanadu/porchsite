"""AF-C1 acceptance, paired with native Worker training-receipt tests."""
import json
import pytest
from server.app import approvals, content, history, oauth, importer
from server.app import site_fields as fields
from server.app.public_http import training_disabled
from .conftest import TABLES
from .web import signed_in, Mcp

ACTOR, ORIGIN = 'assistant:test', 'https://site.example'

@pytest.fixture(autouse=True)
async def clear(db):
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')

async def site(db):
    return await content.create_item(db, ACTOR, 'site', {'title':'Receipt fixture','theme':'personal-homepage','ai_training_disabled':True}, None)

async def publish(db, item):
    a = await approvals.request(db, ACTOR, [item['id']], '')
    await approvals.decide(db, a['id'], {item['id']:{'decision':'approve'}}, '', ORIGIN)
    return a

async def count(db):
    return await db.fetchval('SELECT count(*) FROM training_approvals')

async def old_approve(db, item):
    await db.execute("INSERT INTO live(item_id,kind,slug,data,version,published_at) SELECT id,kind,slug,data,version,'2026-10-17' FROM items WHERE id='site' ON CONFLICT(item_id) DO UPDATE SET data=excluded.data,version=excluded.version")
    await db.execute('UPDATE site_fields SET approved=1 WHERE version=$1', item['version'])

async def test_af_training_receipt_exact_version(db):
    one = await site(db)
    assert await fields.training_data(db, one['version'], False)
    await old_approve(db, one)
    assert not await fields.training_data(db, one['version'], True)
    assert not await training_disabled(db) and await count(db) == 0
    await db.execute('INSERT INTO training_approvals(version) VALUES($1)', one['version']+99)
    assert not await training_disabled(db)
    await fields.fields_approval(db, one['version'])
    assert await training_disabled(db)
    await db.execute("UPDATE site_fields SET approved=0 WHERE key='ai_training_disabled'")
    assert not await training_disabled(db)
    await db.execute("UPDATE site_fields SET approved=1,value='false' WHERE key='ai_training_disabled'")
    assert not await training_disabled(db)
    await db.execute("DELETE FROM site_fields WHERE key='ai_training_disabled'")
    assert not await training_disabled(db)

async def test_af_training_receipt_owner_publish(db):
    one = await site(db)
    a = await publish(db, one)
    assert await training_disabled(db) and await count(db) == 1
    two = await content.update_item(db, ACTOR, 'site', one['version'], {'title':'Changed'})
    wait = await approvals.request(db, ACTOR, ['site'], '')
    await approvals.decide(db, wait['id'], {'site':{'decision':'later'}}, '', ORIGIN)
    assert await count(db) == 1
    await approvals.decide(db, wait['id'], {'site':{'decision':'deny'}}, '', ORIGIN)
    assert await count(db) == 1
    await approvals.publish_now(db, [{'id':'site','version':two['version']}], '', ORIGIN)
    assert await count(db) == 2
    await approvals.decide(db, a['id'], {'site':{'decision':'approve'}}, '', ORIGIN)
    assert await count(db) == 2
    three = await content.update_item(db, ACTOR, 'site', two['version'], {'title':'Third'})
    stale = await approvals.request(db, ACTOR, ['site'], '')
    await content.update_item(db, ACTOR, 'site', three['version'], {'title':'Fourth'})
    await approvals.decide(db, stale['id'], {'site':{'decision':'approve'}}, '', ORIGIN)
    assert await count(db) == 2
    card = await content.create_item(db, ACTOR, 'card', {'name':'Card','description':'Only a card'}, None)
    await publish(db, card)
    assert await count(db) == 2

async def test_af_training_receipt_publication_failure_is_atomic(db):
    one = await site(db)
    await db.execute('ALTER TABLE training_approvals ADD CONSTRAINT receipt_failure CHECK(version<0)')
    try:
        with pytest.raises(Exception):
            await publish(db, one)
        assert await db.fetchval("SELECT version FROM live WHERE item_id='site'") is None
        assert await db.fetchval("SELECT approved FROM site_fields WHERE key='ai_training_disabled'") == 0
        assert await count(db) == 0
    finally:
        await db.execute('ALTER TABLE training_approvals DROP CONSTRAINT receipt_failure')

async def test_af_training_receipt_copy_restore(db):
    one = await site(db)
    await publish(db, one)
    first = (await history.publishes(db))[0]['id']
    two = await content.update_item(db, ACTOR, 'site', one['version'], {'ai_training_disabled':False})
    await publish(db, two)
    assert not await training_disabled(db) and await count(db) == 1
    restored = await content.rollback(db, ACTOR, 'site', one['version'], two['version'])
    assert restored['data']['ai_training_disabled'] and await count(db) == 1
    await old_approve(db, restored)
    assert not await training_disabled(db)
    await approvals.publish_now(db, [{'id':'site','version':restored['version']}], '', ORIGIN)
    assert await training_disabled(db) and await count(db) == 2
    off = await content.update_item(db, ACTOR, 'site', restored['version'], {'ai_training_disabled':False})
    await publish(db, off)
    await history.revert(db, first, '', ORIGIN)
    assert await training_disabled(db) and await count(db) == 3

async def test_af_training_receipt_no_backfill(db, http):
    one = await site(db)
    await old_approve(db, one)
    expected = {'proposed_disabled':True,'effective_disabled':False,'needs_publication':True,'note':fields.TRAINING_NOTE}
    assert await fields.training_state(db) == expected
    http.cookies.update(await signed_in(db))
    review = await http.get('/review')
    assert review.status_code == 200 and fields.TRAINING_NOTE in review.text
    assistant = Mcp(http, await oauth.mint(db, 'Fixture', ORIGIN))
    error, state, _ = await assistant.call('site_state', ids=['site'])
    assert not error and state['training_choice'] == expected
    assert await count(db) == 0
    fresh = await content.update_item(db, ACTOR, 'site', one['version'], {'title':'Fresh shown version'})
    await approvals.request(db, ACTOR, ['site'], '')
    assert await count(db) == 0
    await approvals.publish_now(db, [{'id':'site','version':fresh['version']}], '', ORIGIN)
    assert not (await fields.training_state(db))['needs_publication']

async def test_af_training_receipt_http_parity(db, http):
    one = await site(db)
    await old_approve(db, one)
    before = await http.get('/')
    tag = before.headers['etag']
    assert 'ai-train=yes' in before.headers['content-signal']
    assert 'GPTBot' not in (await http.get('/robots.txt')).text
    await db.execute('UPDATE site_fields SET approved=1')
    assert (await http.get('/', headers={'If-None-Match':tag})).status_code == 304
    await approvals.publish_now(db, [{'id':'site','version':one['version']}], '', ORIGIN)
    after = await http.get('/', headers={'If-None-Match':tag})
    assert after.status_code == 200 and after.headers['etag'] != tag
    assert 'ai-train=no' in after.headers['content-signal']
    assert 'GPTBot' in (await http.get('/robots.txt')).text
    auth = await http.get('/', headers={'Authorization':'Bearer fixture'})
    assert 'no-store' in auth.headers['cache-control'] and 'etag' not in auth.headers
    assert 'training_approvals' not in (await http.get('/')).text


async def test_af_training_receipt_import_does_not_certify(db):
    await importer.import_file(db, json.dumps({'porchsite_import':1,'from':'Fixture','items':[{'kind':'site','data':{'title':'Imported','theme':'personal-homepage','ai_training_disabled':True}}],'training_approvals':[1]}))
    assert await count(db) == 0 and not await training_disabled(db)
    assert (await content.get_item(db, 'site'))['data']['ai_training_disabled']
