"""AF-5 visible-field and inert-script data boundaries, paired with Cloudflare."""
import json
import re
from pathlib import Path
import pytest
from server.app.structured_data import structured_data, structured_block

FIXTURE = json.loads((Path(__file__).parents[3]/'spec/fixtures/agent-markdown.json').read_text())


@pytest.mark.parametrize('doc', FIXTURE['documents'], ids=lambda d: d['name'])
def test_af_jsonld_visible_fields(doc):
    value = {'@context': 'https://schema.org', '@type': doc['structuredType'], 'url': doc['canonical'], 'name': doc['title']}
    if doc['description']:
        value['description'] = doc['description']
    assert json.loads(structured_data(doc['html'], doc['canonical'])) == value


def test_af_injection_payload_matrix():
    name = '</script><script>globalThis.agentPayload=1</script>&\u2028\u2029'
    html = '<html><head><title>Owner</title><meta name="description" content="Hidden description"></head><body><main><h1>&lt;/script&gt;&lt;script&gt;globalThis.agentPayload=1&lt;/script&gt;&amp;\u2028\u2029</h1></main></body></html>'
    for path in ('/', '/notes/', '/notes/tags/example/', '/notes/example/'):
        value = structured_data(html, 'https://example.com'+path)
        obj = json.loads(value)
        assert obj['name'] == name
        assert obj['@type'] == ('CollectionPage' if path == '/notes/' or '/tags/' in path else 'WebPage')
        assert list(obj) == ['@context', '@type', 'url', 'name']
        assert not re.search(r'[<>&\u2028\u2029]', value)
        assert structured_block(html, 'https://example.com'+path).count('</script>') == 1
