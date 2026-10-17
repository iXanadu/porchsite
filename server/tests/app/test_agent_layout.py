"""All-look regression edges from the independent offline CSS audit."""
import json
import re
from datetime import datetime
from pathlib import Path
import pytest
from server.spec.sample import render_sample
from server.app.agent_markdown import markdown_document

ROOT = Path(__file__).parents[3]
SAMPLES = sorted((ROOT/'themes').glob('*/sample.json'))
BOUNDARIES = json.loads((ROOT/'spec/fixtures/agent-markdown.json').read_text())['layoutBoundaries']


@pytest.mark.parametrize('sample', SAMPLES, ids=lambda p: p.parent.name)
def test_af_markdown_visible_text_all_look_boundaries(sample):
    pages = render_sample(sample.parent.name, json.loads(sample.read_text()), 'https://example.com', datetime.fromisoformat('2026-10-15T15:30:00+00:00'))
    for theme, path, left, right in BOUNDARIES:
        if theme != sample.parent.name:
            continue
        markdown = markdown_document(pages[path.lstrip('/')+'index.html'], 'https://example.com'+path)['markdown']
        plain = re.sub(r'\]\(<[^>]*>\)', ']', markdown)
        plain = re.sub(r'\\([\\`*_{}\[\]()#+.!|~-])', r'\1', plain)
        plain = re.sub(r'[*_`\[\]]', '', plain)
        assert left+right not in plain, (theme, path, left, right)
