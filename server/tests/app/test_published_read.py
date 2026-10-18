"""AG-B approved-only pages, cursors and visible timestamps; paired with Worker."""
from datetime import UTC, datetime
import json
from pathlib import Path
import pytest
from server.app import approvals, content, mcp, published_read as published, read_keys as read, site
from server.app.privacy import BLANK
from server.app.read_unicode import read_normalize
from server.app.errors import ApiError
from .conftest import TABLES
from .test_read_keys import rpc

ORIGIN, ACTOR = 'https://site.example', 'assistant:test'

@pytest.fixture(autouse=True)
async def clear(db, monkeypatch):
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    await db.execute('UPDATE auth_state SET owner_epoch=0 WHERE id=1')
    monkeypatch.setattr(published, '_clock', lambda: datetime(2026, 10, 17, 12, tzinfo=UTC))

async def publish(db, item):
    await approvals.publish_now(db, [{'id': item['id'], 'version': item['version']}], '', ORIGIN)

async def fixture(db, n=3):
    one = await content.create_item(db, ACTOR, 'site', {'title': 'Reader site', 'theme': 'personal-homepage', 'archive': {'enabled': True, 'title': 'All entries'}, 'streams': [{'id': 'one', 'title': 'One'}, {'id': 'two', 'title': 'Two'}]}, None)
    await publish(db, one)
    entries = []
    for i in range(n):
        entry = await content.create_item(db, ACTOR, 'entry', {'title': 'Page '+str(i), 'date': '2026-10-17', 'stream': 'two' if i%2 else 'one', 'tags': ['other' if i%2 else 'report'], 'body': 'Café woodwork. '+'🦊'*260 if i == 0 else 'Published text '+str(i)}, None)
        await publish(db, entry)
        entries.append(entry)
    made = await read.create(db, 'Reader')
    principal = {**await read.lookup(db, made['token']), 'origin': ORIGIN}
    return one, entries, made, principal

async def call(http, token, name, args=None, fallback=False):
    response, out = await rpc(http, token, 'tools/call', {'name': name, 'arguments': args or {}}, fallback)
    value = json.loads(out['result']['content'][0]['text']) if out.get('result', {}).get('content') else None
    return response, out, value

@pytest.mark.parametrize('fallback', [False, True])
async def test_ag_read_tools_live_only(db, http, fallback):
    one, entries, made, principal = await fixture(db)
    pending = await content.update_item(db, ACTOR, entries[0]['id'], entries[0]['version'], {'body': 'DRAFT_VERSION_CANARY'})
    await approvals.request(db, ACTOR, [pending['id']], 'Pending')
    draft = await content.create_item(db, ACTOR, 'entry', {'title': 'HIDDEN_DRAFT_CANARY', 'body': 'Hidden draft body', 'date': '2026-10-17', 'status': 'draft'}, None)
    await publish(db, draft)
    private_card = await content.create_item(db, ACTOR, 'card', {'name': 'HIDDEN_CARD_CANARY', 'description': 'HIDDEN_CARD_TEXT', 'visibility': 'private'}, None)
    await publish(db, private_card)
    mention = await content.create_item(db, ACTOR, 'card', {'name': 'Visible mention', 'description': 'Visible mention text', 'visibility': 'mention', 'link': 'https://example.com/HIDDEN_MENTION_LINK'}, None)
    await publish(db, mention)
    path = '/one/'+entries[0]['slug']+'/'
    response, out, got = await call(http, made['token'], 'page_get', {'path': path+'index.md'}, fallback)
    assert not out['result'].get('isError') and got['path'] == path
    assert got['markdown'] == (await http.get(path+'index.md')).text
    assert got['tags'] == ['report'] and got['date'] == '2026-10-17'
    _, _, state = await call(http, made['token'], 'site_state', {'guide': {}}, fallback)
    _, _, listing = await call(http, made['token'], 'pages_list', {}, fallback)
    _, _, result = await call(http, made['token'], 'search', {'query': 'CAFE\u0301 woodwork'}, fallback)
    assert state['pages'] == listing['pages'] and any(r['path'] == path for r in result['results'])
    combined = json.dumps([got, state, listing, result])
    for secret in ['DRAFT_VERSION_CANARY', 'HIDDEN_DRAFT_CANARY', 'HIDDEN_CARD_CANARY', 'HIDDEN_CARD_TEXT', 'HIDDEN_MENTION_LINK']:
        assert secret not in combined
    assert response.headers['cache-control'] == 'private, no-store, no-transform'
    assert await published.pages_list(db, {'stream': 'missing'}, principal) == {'pages': [], 'next_cursor': None}
    assert await published.pages_list(db, {'tag': 'missing'}, principal) == {'pages': [], 'next_cursor': None}
    hidden = await content.update_item(db, ACTOR, 'site', one['version'], {'private': True})
    await publish(db, hidden)
    _, _, got = await call(http, made['token'], 'page_get', {'path': path}, fallback)
    assert 'Café woodwork' in got['markdown']
    # Slice C replaces B's no-HTTP checkpoint with published reader HTML only.
    private_html = await http.get(path, headers={'Authorization': 'Bearer '+made['token'], 'If-None-Match': '*'})
    assert private_html.status_code == 200 and 'Café woodwork' in private_html.text
    assert private_html.headers['cache-control'] == 'private, no-store, no-transform'
    assert not any(name in private_html.headers for name in ('etag', 'last-modified', 'content-signal'))
    for headers in ({}, {'Authorization': 'Bearer psk_unknown'}):
        denied = await http.get(path, headers=headers)
        assert denied.status_code == 404 and 'Café woodwork' not in denied.text
    writer = await mcp._call(db, 'page_get', {'path': path}, {'client': 'writer', 'clientId': 'writer-1', 'origin': ORIGIN}, 'test')
    assert not writer.is_error

async def test_ag_read_cursor(db):
    _, entries, _, principal = await fixture(db, 23)
    first = await published.pages_list(db, {}, principal)
    state = await published.state(db, {}, principal)
    assert len(first['pages']) == 20 and first['next_cursor'] and state['next_cursor'] == first['next_cursor']
    next_page = await published.pages_list(db, {'cursor': first['next_cursor']}, principal)
    paths = [p['path'] for p in first['pages']+next_page['pages']]
    assert len(set(paths)) == len(paths) and paths == sorted(paths) and next_page['next_cursor'] is None
    other = await read.create(db, 'Other')
    foreign = {**await read.lookup(db, other['token']), 'origin': ORIGIN}
    for args, props in [({'cursor': first['next_cursor']}, foreign), ({'cursor': first['next_cursor'], 'tag': 'report'}, principal), ({'cursor': first['next_cursor']}, {'client': 'writer', 'clientId': 'writer', 'origin': ORIGIN})]:
        with pytest.raises(ApiError) as error:
            await published.pages_list(db, args, props)
        assert error.value.code == 'invalid'
    staged = await content.update_item(db, ACTOR, entries[0]['id'], entries[0]['version'], {'body': 'Unapproved cursor change'})
    assert (await published.pages_list(db, {}, principal))['next_cursor'] == first['next_cursor']
    hidden = await content.create_item(db, ACTOR, 'card', {'name': 'Invisible cursor input', 'description': 'Private fixture description', 'visibility': 'private'}, None)
    await publish(db, hidden)
    assert (await published.pages_list(db, {}, principal))['next_cursor'] == first['next_cursor']
    await publish(db, staged)
    with pytest.raises(ApiError) as error:
        await published.pages_list(db, {'cursor': first['next_cursor']}, principal)
    assert error.value.code == 'cursor_stale'

async def test_ag_read_visible_timestamps(db):
    _, entries, _, _ = await fixture(db)
    notes = []
    for i in range(13):
        note = await content.create_item(db, ACTOR, 'note', {'text': 'Visible note '+str(i), 'date': f'2026-09-{i+1:02d}'}, None)
        await publish(db, note)
        notes.append(note)
    await db.execute("UPDATE live SET published_at='2026-10-17T10:00:00.000Z'")
    before = await site.live_view(db)
    hidden = await content.create_item(db, ACTOR, 'card', {'name': 'Invisible date row', 'description': 'Private fixture description', 'visibility': 'private'}, None)
    await publish(db, hidden)
    await db.execute("UPDATE live SET published_at='2030-01-01T00:00:00.000Z' WHERE item_id=$1", hidden['id'])
    draft = await content.create_item(db, ACTOR, 'entry', {'title': 'Invisible status date', 'date': '2026-10-17', 'status': 'draft'}, None)
    await publish(db, draft)
    await db.execute("UPDATE live SET published_at='2031-01-01T00:00:00.000Z' WHERE item_id=$1", draft['id'])
    await db.execute("UPDATE live SET published_at='2032-01-01T00:00:00.000Z' WHERE item_id=$1", notes[0]['id'])
    after, discovery = await site.live_view(db), await site.live_view(db, True)
    assert after.updated == before.updated
    for item in [hidden, draft, notes[0]]:
        assert item['id'] not in discovery.approved_at
    assert entries[0]['id'] in discovery.approved_at

async def test_ag_read_invalid_inputs(db, monkeypatch):
    _, _, _, principal = await fixture(db)
    original, calls = site.live_view, []
    async def load(*args, **kwargs):
        calls.append(True)
        return await original(*args, **kwargs)
    monkeypatch.setattr(site, 'live_view', load)
    for path in ['https://example.com/', '//example.com/', '/a/../', '/a/%2f/', '/a/%5c/', '/a/#x', '/archive/?tag=x%0A', '/archive/?sort=date&sort=stream', '/archive/?unknown=1']:
        calls.clear()
        with pytest.raises(ApiError) as error:
            await published.page_get(db, {'path': path}, principal)
        assert error.value.code == 'invalid' and not calls
    for args in [{'query': ''}, {'query': ' '*20}, {'query': '🦊'*201}, {'query': 'x', 'cursor': 'ag2_bad'}, {'query': 'x', 'limit': 51}]:
        calls.clear()
        with pytest.raises(ApiError) as error:
            await published.search(db, args, principal)
        assert error.value.code == 'invalid' and not calls
    for path in ['/review/', '/media/example.jpg', '/missing/', '/mcp/']:
        with pytest.raises(ApiError) as error:
            await published.page_get(db, {'path': path}, principal)
        assert error.value.code == 'not_found'
    found = await published.search(db, {'query': '🦊'*200}, principal)
    assert found['results'] and all(len(r['excerpt']) <= 240 for r in found['results'])

@pytest.mark.parametrize('name', ['page_get', 'pages_list', 'search'])
async def test_ag_read_revocation_race(db, monkeypatch, name):
    _, entries, made, principal = await fixture(db)
    original = getattr(published, name)
    async def barrier(*args, **kwargs):
        value = await original(*args, **kwargs)
        await read.revoke(db, made['id'])
        return value
    monkeypatch.setattr(published, name, barrier)
    args = {'path': '/one/'+entries[0]['slug']+'/'} if name == 'page_get' else {'query': 'woodwork'} if name == 'search' else {}
    result = await mcp._call(db, name, args, principal, 'test')
    assert result.is_error and 'Café' not in result.content[0].text and 'Reader site' not in result.content[0].text

def test_ag_read_unicode():
    cases = json.loads((Path(__file__).resolve().parents[3] / "spec/fixtures/read-unicode.json").read_text())
    for source, expected in cases:
        assert read_normalize(source) == expected

async def test_ag_read_since(db, monkeypatch):
    _, entries, _, principal = await fixture(db)
    await db.execute("UPDATE live SET published_at='2026-10-16T00:00:00Z'")
    await db.execute("UPDATE live SET published_at='2026-10-17T12:00:00.0001Z' WHERE item_id=$1", entries[0]['id'])
    rows = await published.pages_list(db, {'since':'2026-10-17t12:00:00.00009z'}, principal)
    assert [p['path'] for p in rows['pages']] == ['/one/'+entries[0]['slug']+'/']
    assert (await published.pages_list(db, {'since':'2026-10-17T12:00:00.0001Z'}, principal))['pages'] == []
    async def refuse(*args, **kwargs):
        pytest.fail('invalid timestamp must not look up content')
    monkeypatch.setattr(site, 'live_view', refuse)
    for since in ['2026-10-17T12:00:00Z\n','2026-02-30T00:00:00Z','2026-10-17T12:00:00+00:00']:
        with pytest.raises(ApiError) as error:
            await published.pages_list(db, {'since':since}, principal)
        assert error.value.code == 'invalid'

@pytest.mark.parametrize('name', ['page_get','pages_list','search'])
async def test_ag_read_publication_race(db, monkeypatch, name):
    _, entries, _, principal = await fixture(db)
    original, calls = site.live_view, 0
    async def changing(*args, **kwargs):
        nonlocal calls
        value = await original(*args, **kwargs)
        calls += 1
        if calls == 1:
            await db.execute('DELETE FROM live WHERE item_id=$1', entries[0]['id'])
        return value
    monkeypatch.setattr(site, 'live_view', changing)
    handler = {'page_get':published.page_get,'pages_list':published.pages_list,'search':published.search}[name]
    args = {'path':'/one/'+entries[0]['slug']+'/'} if name == 'page_get' else {'query':'woodwork'} if name == 'search' else {}
    with pytest.raises(ApiError) as error:
        await handler(db, args, principal)
    assert error.value.code == ('not_found' if name == 'page_get' else 'cursor_stale')

async def test_ag_read_clock_boundary(db, monkeypatch):
    _, _, _, principal = await fixture(db)
    original, calls = site.live_view, 0
    async def crossing(*args, **kwargs):
        nonlocal calls
        value = await original(*args, **kwargs)
        calls += 1
        if calls == 2:
            monkeypatch.setattr(published, '_clock', lambda: datetime(2026,10,17,12,1,tzinfo=UTC))
        return value
    monkeypatch.setattr(site, 'live_view', crossing)
    with pytest.raises(ApiError) as error:
        await published.pages_list(db, {}, principal)
    assert error.value.code == 'cursor_stale'
