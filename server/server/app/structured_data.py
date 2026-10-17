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


def structured_view_block(v,canonical):
    """Engine facts from approved fields, without HTML or body projection."""
    from urllib.parse import urlsplit
    path=urlsplit(canonical).path
    entry=next((e for e in v.entries if e['page']==path and not e.get('external_url')),None)
    match=re.fullmatch(r'/([a-z][a-z0-9-]{0,29})/(?:tags/([a-z0-9-]{1,30})/)?',path)
    stream=next((s for s in v.site['streams'] if (s.get('path') or s['id'])==match[1]),None) if match else None
    archive=path=='/archive/' and v.site.get('archive',{}).get('enabled')
    name=entry['title'] if entry else v.site['archive']['title'] if archive else (('#'+match[2]+' · ') if match[2] else '')+stream['title'] if stream else v.site['title']
    description=entry.get('summary') if entry else '' if archive else stream.get('description') if stream else v.site.get('description')
    value={'@context':'https://schema.org','@type':'CollectionPage' if archive or stream else 'WebPage','url':canonical,'name':str(name or '')}
    if description:
        value['description']=str(description)
    text=json.dumps(value,ensure_ascii=False,separators=(',',':'))
    text=re.sub(r'[<>&\u2028\u2029]',lambda m:'\\u'+format(ord(m[0]),'04x'),text)
    return '<script type="application/ld+json">'+text+'</script>'
