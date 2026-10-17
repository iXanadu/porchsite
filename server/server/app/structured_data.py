"""Inert structured facts from the visitor text projection."""
import json
import re
from urllib.parse import urlsplit
from .agent_markdown import markdown_document


def structured_data(html, canonical):
    doc = markdown_document(html, canonical)
    collection = bool(re.fullmatch(r'/[a-z][a-z0-9-]{0,29}/(?:tags/[a-z0-9-]{1,30}/)?', urlsplit(canonical).path))
    value = {'@context': 'https://schema.org', '@type': 'CollectionPage' if collection else 'WebPage', 'url': canonical, 'name': doc['title']}
    if doc['description']:
        value['description'] = doc['description']
    encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return re.sub(r'[<>&\u2028\u2029]', lambda m: '\\u'+format(ord(m[0]), '04x'), encoded)


def structured_block(html, canonical):
    return '<script type="application/ld+json">'+structured_data(html, canonical)+'</script>'
