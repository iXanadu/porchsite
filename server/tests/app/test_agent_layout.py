"""Independent all-look source-boundary scan, paired with the Worker test."""
import json
import re
from datetime import datetime
from pathlib import Path
import pytest
from server.spec.sample import render_sample
from server.app.agent_markdown import markdown_document

ROOT = Path(__file__).parents[3]
SAMPLES = sorted((ROOT/'themes').glob('*/sample.json'))
INLINE = set('abbr b cite code dfn em i kbd q samp script strong style sub sup u var'.split())


@pytest.mark.parametrize('sample', SAMPLES, ids=lambda p: p.parent.name)
def test_af_markdown_visible_text_all_look_boundaries(sample):
    pages = render_sample(sample.parent.name, json.loads(sample.read_text()), 'https://example.com', datetime.fromisoformat('2026-10-15T15:30:00+00:00'))
    for path, html in pages.items():
        if not path.endswith('index.html'):
            continue
        markdown = markdown_document(html, 'https://example.com/'+path[:-10])['markdown']
        for match in re.finditer(r'([^\W_]+)</([a-z][\w:-]*)>\s*<([a-z][\w:-]*)\b[^>]*>([^\W_]+)', html):
            if match[2] in INLINE or match[3] in INLINE:
                continue
            assert match[1]+match[4] not in markdown, (sample.parent.name, path, match[1], match[4])
