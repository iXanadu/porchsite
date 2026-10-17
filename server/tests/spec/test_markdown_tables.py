"""MD-1 bounds and special-block handling, paired with native Worker tests."""
import re
from server.spec.html import markdown
from server.app.agent_markdown import markdown_document


def test_md_pipe_table_bounds():
    def source(n):
        return '| '+' | '.join(['H']*n)+' |\n| '+' | '.join(['-']*n)+' |'
    assert len(re.findall(r'<th ', markdown(source(64)))) == 64
    assert '<table' not in markdown(source(65))
    full = source(64)+'\n'+'\n'.join(['kept']*64)
    rendered = markdown(full+'\n\n> '+source(2).replace('\n', '\n> '))
    assert len(re.findall(r'<(?:th|td)\b', rendered)) == 4096
    assert '<p>kept</p>' in rendered and rendered.count('<table ') == 1
    assert '<blockquote><p>' in rendered


def test_md_pipe_tables_special_blocks():
    calls = []
    def block(line):
        if line == '!embed[demo]':
            calls.append(line)
            return '<aside>Embedded</aside>'
    result = markdown('A | B\n- | -\n!embed[demo]', block)
    assert len(calls) == 1 and result.endswith('</table></div>\n<aside>Embedded</aside>')
    calls.clear()
    assert '!embed[demo]' in markdown('A | B\n- | -\nx | !embed[demo]', block)
    assert calls == []


def test_af_pipe_table_roundtrip():
    body = markdown('| Header | Value |\n| :-- | --: |\n| `a\\\\b` | <script> |\n| x\\|y | ![alt\\|text](/media/'+'a'*32+'.png) |')
    result = markdown_document('<main><h1>Round trip</h1>'+body+'</main>', 'https://example.com/table/')['markdown']
    assert '| :--- | ---: |' in result and '` a\\\\b `' in result
    assert 'x\\|y' in result and '&lt;script&gt;' in result
    assert '![alt\\|text]' in result and '<table' not in result
