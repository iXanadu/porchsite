"""Minimal copy escaping preserves punctuation and literal Markdown data."""
import json
from html.parser import HTMLParser
from pathlib import Path
import pytest
from markdown_it import MarkdownIt
from server.app.agent_markdown import markdown_document

CASES=json.loads((Path(__file__).parents[3]/'spec/fixtures/markdown-escaping.json').read_text())

class Visible(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.parts=[]
        self.feed(source)
    def handle_data(self,data):
        self.parts.append(data)
    def handle_starttag(self,tag,attrs):
        if tag=='img': self.parts.append(dict(attrs).get('alt',''))
        if tag in ('p','br'): self.parts.append(' ')

@pytest.mark.parametrize('case',CASES,ids=lambda c:c['name'])
def test_af_markdown_minimal_escaping(case):
    assert markdown_document(case['html'],case['canonical'])['markdown']==case['markdown']
    rendered=MarkdownIt('commonmark').render(case['content'])
    assert ' '.join(''.join(Visible(rendered).parts).split())==case['visible']
    assert '<script>' not in rendered and 'href="javascript:' not in rendered
