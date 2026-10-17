"""Shared AF data-boundary and Accept fixtures; no external conversion."""
import json
from pathlib import Path
import pytest
from server.app.agent_markdown import markdown_document
from server.app.public_http import representation

FIXTURE = json.loads((Path(__file__).parents[3]/'spec/fixtures/agent-markdown.json').read_text())


@pytest.mark.parametrize('doc', FIXTURE['documents'], ids=lambda d: d['name'])
def test_af_markdown_frozen_template(doc):
    assert markdown_document(doc['html'], doc['canonical']) == {k: doc[k] for k in ('title', 'description', 'markdown')}


@pytest.mark.parametrize('accept,selected', FIXTURE['accept'])
def test_af_accept_negotiation(accept, selected):
    assert representation(accept) == selected


async def test_af_map_links_resolve_bounded_unicode():
    from starlette.requests import Request
    from starlette.responses import Response
    from server.app.agent_pages import agent_page
    from server.app.agent_map import map_response
    import re
    for title in ('Visible title', '🐦'*120):
        paths = ['/notes/page-'+str(i)+'/' for i in range(80)]
        async def route(req):
            return Response('<html><head><title>'+title+'</title></head><body><main><h1>'+title+'</h1><p>Owner text</p></main></body></html>', status_code=404 if req.url.path == '/notes/page-1/' else 200, media_type='text/html')
        async def get_paths():
            return map_response([dict(path=p,title=title,description='') for p in ['/',*paths] if p != '/notes/page-1/'], 'https://example.com')
        req = Request({'type': 'http', 'method': 'GET', 'scheme': 'https', 'server': ('example.com', 443), 'path': '/llms.txt', 'query_string': b'', 'headers': []})
        response = await agent_page(req, route, get_paths, 'https://example.com', route)
        body = response.body.decode()
        assert len(response.body) <= 16384
        links = re.findall(r'^- \[.*\]\(<(https://example.com/[^>]*index\.md)>\)', body, re.M)
        assert 1 < len(links) <= 50
        assert '/notes/page-1/index.md' not in body
        assert body.endswith('\n') and '�' not in body
