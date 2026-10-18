import json
from pathlib import Path

import pytest
from starlette.requests import Request
from starlette.responses import Response

from server.app.agent_pages import agent_page
from server.app.theme import render
from server.spec import embeds
from server.spec.sample import sample_view
from server.spec.theme import home_view, archive_view, entry_view

ROOT = Path(__file__).parents[3]
FIXTURE = json.loads((ROOT / 'spec/fixtures/lazy-bodies.json').read_text())
SAMPLE = json.loads((ROOT / 'themes/personal-homepage/sample.json').read_text())
POLICY = {'sources': [FIXTURE['source']], 'origin': FIXTURE['origin']}


def state(count=20):
    view = sample_view('personal-homepage', SAMPLE)
    original = view.entries[0]
    view.entries = [{**original, 'id': f'e{i}', 'slug': f'e{i}',
        'page': f"/{original['stream']}/e{i}/", 'url': f"/{original['stream']}/e{i}/",
        'body': FIXTURE['body'], 'summary': FIXTURE['summary']} for i in range(count)]
    view.site['sections'] = [original['stream']]
    return view


def theme(template, headings=False):
    return {'manifest': {'heading_ids': headings, 'body_h1_as_h2': headings},
        'pages': dict.fromkeys(['home', 'archive', 'entry'], template), 'partials': {}}


def counter(monkeypatch):
    calls = []
    original = embeds.body_markdown
    def counted(source, *args, **kwargs):
        if source == FIXTURE['body']:
            calls.append((args, kwargs))
        return original(source, *args, **kwargs)
    monkeypatch.setattr(embeds, 'body_markdown', counted)
    return calls


@pytest.mark.parametrize('headings', [False, True])
def test_unused_body_is_not_parsed_by_metadata_heading_or_capability_walk(monkeypatch, headings):
    calls = counter(monkeypatch)
    view = state(200)
    marker = '<porchsite-embed data-key="authored" data-url="https%3A%2F%2Fexample.com%2Fplayer" data-title="Tour"></porchsite-embed>'
    home = render(theme(marker+'{{#sections}}{{#all}}{{summary}}{{/all}}{{/sections}}', headings),
        'home', home_view(view, '1', FIXTURE['origin']), POLICY)
    stream = next(s for s in view.site['streams'] if s['id'] == view.entries[0]['stream'])
    archive = render(theme('{{#entries}}{{summary}}{{/entries}}', headings), 'archive',
        archive_view(view, stream['path'] or stream['id'], '1', FIXTURE['origin']), POLICY)
    assert FIXTURE['summary'] in home and FIXTURE['summary'] in archive
    assert '<iframe ' not in home
    assert calls == []


def test_consumed_repeated_body_renders_once_with_heading_policy_and_embed_cap(monkeypatch):
    calls = counter(monkeypatch)
    view = state()
    output = render(theme('{{#sections}}{{#all}}{{{body_html}}}{{/all}}{{/sections}}', True),
        'home', home_view(view, '1', FIXTURE['origin']), POLICY)
    assert len(calls) == 1
    assert output.count('<iframe ') == 12
    assert output.count('<table ') == 20
    assert '<h2 id="repeated-heading">' in output and '<h1' not in output
    assert '<porchsite-embed' not in output


def test_memo_does_not_cross_view_or_heading_policy_or_mutate_original(monkeypatch):
    calls = counter(monkeypatch)
    view = state(1)
    original = entry_view(view, view.entries[0], '1', FIXTURE['origin'])
    look = theme('{{{entry.body_html}}}', True)
    assert 'id="repeated-heading"' in render(look, 'entry', original, POLICY)
    assert '<h1>Repeated heading</h1>' in render({**look, 'manifest': {}}, 'entry', original, POLICY)
    other = entry_view(view, view.entries[0], '1', FIXTURE['origin'])
    render({**look, 'manifest': {}}, 'entry', other, POLICY)
    assert len(calls) == 3


def request(path, headers=None):
    from urllib.parse import urlsplit
    value = urlsplit(FIXTURE['origin']+path)
    return Request({'type': 'http', 'method': 'GET', 'scheme': value.scheme,
        'path': value.path, 'raw_path': value.path.encode(), 'query_string': value.query.encode(),
        'server': (value.hostname, 443), 'headers': [(k.lower().encode(), v.encode()) for k,v in (headers or {}).items()]})


async def test_anonymous_negotiated_markdown_renders_once_preserving_direct_bytes_and_vary():
    calls = []
    async def route(req):
        calls.append(req)
        return Response('<html><head><title>Title</title></head><body><main><h1>Title</h1><p>Visible</p></main></body></html>',
            headers={'Content-Type': 'text/html; charset=utf-8', 'Vary': 'Origin'})
    async def missing(_req): return Response('missing', status_code=404)
    async def map_response(): return Response('map')
    negotiated = await agent_page(request('/', {'Accept': 'text/markdown'}), route, map_response, FIXTURE['origin'], missing)
    assert len(calls) == 1 and 'Accept' not in calls[0].headers
    assert negotiated.headers['Vary'] == 'Origin, Accept'
    calls.clear()
    direct = await agent_page(request('/index.md'), route, map_response, FIXTURE['origin'], missing)
    assert len(calls) == 1 and direct.body == negotiated.body


async def test_credentialed_projection_stays_separate_and_misses_do_not_grant_markdown():
    calls = []
    async def route(req):
        calls.append(req)
        return Response('<html><head><title>Title</title></head><body><main>Visible</main></body></html>', headers={'Content-Type': 'text/html; charset=utf-8'})
    async def missing(_req): return Response('missing', status_code=404)
    async def map_response(): return Response('map')
    await agent_page(request('/', {'Accept': 'text/markdown', 'Cookie': '__Host-sk_owner=invalid'}), route, map_response, FIXTURE['origin'], missing)
    assert len(calls) == 2
    calls.clear()
    async def denied(req):
        calls.append(req)
        return Response('missing', status_code=404, headers={'Content-Type': 'text/html; charset=utf-8'})
    response = await agent_page(request('/', {'Accept': 'text/markdown'}), denied, map_response, FIXTURE['origin'], missing)
    assert response.status_code == 404 and response.body == b'missing' and len(calls) == 1
