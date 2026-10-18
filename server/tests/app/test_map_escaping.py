"""The map is raw-readable data; hostile metadata cannot create extra rows."""
import json
from pathlib import Path
import pytest
from markdown_it import MarkdownIt
from server.app.agent_map import map_response
CASES=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/map-escaping.json').read_text())

@pytest.mark.parametrize('case',CASES,ids=lambda c:c['name'])
def test_ll2_map_escaping(case):
    response=map_response([dict(path='/',title=case['title'],description=case['description'])],'https://site.example')
    title,description=case['escaped_title'],case['escaped_description']
    expected=f'# {title}\n\n{description}\n\n- [{title}](<https://site.example/index.md>): {description}\n'
    assert response.body.decode()==expected
    assert response.headers['content-type']=='text/markdown; charset=utf-8'
    tokens=MarkdownIt('commonmark').parse(expected)
    assert sum(t.type=='bullet_list_open' for t in tokens)==1
    assert sum(t.type=='heading_open' for t in tokens)==1
    children=[child for token in tokens for child in token.children or []]
    links=[t for t in children if t.type=='link_open']
    assert len(links)==1 and links[0].attrGet('href')=='https://site.example/index.md'
    assert all(t.type not in ('html_block','fence') for t in tokens)
    assert all(t.type!='html_inline' for t in children)
