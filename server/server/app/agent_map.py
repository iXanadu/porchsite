"""Bounded map metadata from one approved reader view; never render bodies."""
from starlette.responses import Response
from .agent_markdown import inline_text, md_text
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

def map_response(pages, origin):
    rows, seen, count = [], set(), 0
    for page in pages:
        path = page['path']
        if path in seen or not page_path(path):
            continue
        seen.add(path)
        title = md_text(inline_text(page['title'])[:512])
        description = md_text(inline_text(page['description'])[:2048])
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
