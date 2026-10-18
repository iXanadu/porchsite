"""Minimal copy escaping preserves punctuation and literal Markdown data."""
import json
from html.parser import HTMLParser
from pathlib import Path
import pytest
from markdown_it import MarkdownIt
from server.app.agent_markdown import markdown_document

CASES=json.loads((Path(__file__).parents[3]/'spec/fixtures/markdown-escaping.json').read_text())
INTRAWORD=json.loads((Path(__file__).parents[3]/'spec/fixtures/markdown-intraword.json').read_text())

@pytest.mark.parametrize('case',INTRAWORD,ids=lambda c:c['name'])
def test_af_markdown_intraword_underscore(case):
    actual=markdown_document(case['html'],case['canonical'])['markdown']
    assert actual==case['markdown']
    for gfm in (False,True):
        parser=MarkdownIt('commonmark')
        if gfm: parser.enable(['strikethrough','table'])
        # The legacy escaped image alt loses its underscore in the parser.
        assert parser.render(actual)==case.get('rendered',parser.render(case['legacy']))

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
    rendered=MarkdownIt('commonmark').enable(['strikethrough','table']).render(case['content'])
    assert ' '.join(''.join(Visible(rendered).parts).split())==case['visible']
    assert '<script>' not in rendered and 'href="javascript:' not in rendered

    if case['name'].startswith('joined_'):
        assert '<ol' not in rendered and '<s>' not in rendered and '<hr' not in rendered
