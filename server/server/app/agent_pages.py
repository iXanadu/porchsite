"""Public data twins; invoked only after the private-site gate."""
import re
from starlette.requests import Request
from starlette.responses import Response
from .agent_markdown import markdown_document
from .public_http import markdown_path, page_path, page_query, representation, session_request

from .structured_data import structured_block, structured_view_block

MD = {'Content-Type': 'text/markdown; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'Link': '</llms.txt>; rel="describedby"'}


def anonymous(req, path, preserve_query=False):
    return Request({**req.scope, 'method': 'GET', 'path': path, 'raw_path': path.encode(), 'query_string': req.scope['query_string'] if preserve_query and path == '/archive/' else b'', 'headers': [(k,v) for k,v in req.scope['headers'] if k.lower() == b'host']})


def is_html(response):
    return response.status_code == 200 and response.headers.get('Content-Type') == 'text/html; charset=utf-8'


async def agent_page(req, route, map_response, origin, not_found, view=None):
    path = req.url.path
    if req.method != 'GET':
        return await route(req)
    if path == '/llms.txt':
        return await map_response()
    base = markdown_path(path)
    if base or re.search(r'/index\.md/?$', path):
        if not base:
            return await not_found(req)
        response = await route(anonymous(req, base, True))
        if base == '/archive/' and response.status_code == 400:
            return response
        if not is_html(response):
            return await not_found(req)
        return Response(markdown_document(response.body.decode(), origin+base+page_query(req, base))['markdown'], headers=MD)
    response = await route(req)
    if not page_path(path) or not is_html(response):
        return response
    selected = representation(req.headers.get('Accept'))
    headers = dict(response.headers)
    headers['vary'] = (headers['vary']+', Accept') if headers.get('vary') else 'Accept'
    headers.pop('content-length', None)
    if selected is None:
        return Response(None, status_code=406, headers={'Vary': 'Accept', 'Cache-Control': 'private, no-store, no-transform'})
    if selected == 'markdown':
        visitor = await route(anonymous(req, path, True))
        if not is_html(visitor):
            return visitor
        return Response(markdown_document(visitor.body.decode(), origin+path+page_query(req, path))['markdown'], headers={**MD, 'Vary': headers['vary']})
    copy = path+'index.md'+page_query(req, path)
    link = '<'+copy+'>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"'
    headers['link'] = ', '.join(x for x in (headers.get('link'), link) if x)
    original = response.body.decode()
    if path == '/archive/':
        canonical = (origin+path+page_query(req, path)).replace('&', '&amp;')
        original = re.sub(r'<link rel="canonical" href="[^"]*">', lambda _: '<link rel="canonical" href="'+canonical+'">', original, count=1)
    visitor_html = original
    if view is None and session_request(req):
        visitor = await route(anonymous(req, path, True))
        if not is_html(visitor):
            return visitor
        visitor_html = visitor.body.decode()
    canonical=origin+path+page_query(req,path)
    data = structured_view_block(await view(),canonical) if view is not None else structured_block(visitor_html,canonical)
    body = original.replace('</head>', data+'<link rel="alternate" type="text/markdown" href="'+copy.replace('&', '&amp;')+'"></head>', 1)
    return Response(body, headers=headers)
