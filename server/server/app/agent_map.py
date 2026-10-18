"""Bounded map metadata from one approved reader view; never render bodies."""
from starlette.responses import Response
import re
from .agent_markdown import inline_text
from .public_http import page_path

MAP_HEADERS = {'Content-Type':'text/markdown; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",'Link':'</llms.txt>; rel="describedby"'}

def map_pages(v):
    if not v.approved_at.get('site'):
        return []
    pages = [dict(path='/', title=str(v.site.get('title') or ''), description=str(v.site.get('description') or ''))]
    if v.site.get('archive', {}).get('enabled'):
        pages.append(dict(path='/archive/', title=str(v.site['archive']['title']), description=''))
    for stream in v.site['streams']:
        pages.extend(dict(path=e['page'], title=str(e['title']), description=str(e.get('summary') or '')) for e in v.entries if e['stream']==stream['id'] and not e.get('external_url'))
    return pages

def _field(value, cap):
    text = inline_text(re.sub(r'[\v\u0085\u2028\u2029]', ' ', value))[:cap]
    text = re.sub(r'[\\[\]<>]', lambda m: '\\'+m[0], text)
    text = re.sub(r'^(#{1,6}(?= |$)|[-+*](?= |$)|`{3,}|~{3,}|(?:- *){3,}$|(?:_ *){3,}$|(?:\* *){3,}$)', lambda m: '\\'+m[0], text)
    return re.sub(r'^(\d{1,9})([.)])(?= |$)', lambda m: m[1]+'\\'+m[2], text)


def map_response(pages, origin):
    rows, seen, count = [], set(), 0
    for page in pages:
        path = page['path']
        if path in seen or not page_path(path):
            continue
        seen.add(path)
        title = _field(page['title'], 512)
        description = _field(page['description'], 2048)
        if not rows:
            rows.extend(['# '+title, ''])
            if description:
                rows.extend([description, ''])
        line = '- ['+title+'](<'+origin+path+'index.md>)'+(': '+description if description else '')
        if len(('\n'.join([*rows,line,''])).encode()) > 16384:
            break
        rows.append(line)
        count += 1
        if count == 50:
            break
    return Response('\n'.join(rows)+'\n', headers=MAP_HEADERS)
