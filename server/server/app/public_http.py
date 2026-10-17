"""Public representation metadata, applied only after the private-site gate."""
import hashlib
import json
import re

from starlette.responses import Response
from server.spec.sitemap import robots
from .privacy import no_store

PUBLIC_CACHE = 'public, no-cache, must-revalidate, no-transform'


def training_signal(disabled):
    return 'search=yes, ai-input=yes, ai-train=' + ('no' if disabled else 'yes')


def public_path(path):
    return path in ('/', '/robots.txt', '/sitemap.xml') or bool(re.fullmatch(
        r'/[a-z][a-z0-9-]{0,29}/(?:[a-z0-9-]{1,80}/|tags/[a-z0-9-]{1,30}/|feed\.xml)?', path))


def session_request(req):
    return 'authorization' in req.headers or bool(re.search(
        r'(?:^|;\s*)__Host-sk_(?:owner|reader)=', req.headers.get('cookie', '')))


async def training_disabled(db):
    row = await db.fetchrow("SELECT f.value FROM live l JOIN site_fields f ON f.version = l.version AND f.key = 'ai_training_disabled' AND f.approved = 1 WHERE l.item_id = 'site'")
    return bool(row and json.loads(row['value']) is True)


def matches_tag(value, tag):
    if not value:
        return False
    value = value.strip()
    if value == '*':
        return True
    if not re.fullmatch(r'[ \t]*(?:W/)?"[\x21\x23-\x7e\x80-\xff]*"[ \t]*(?:,[ \t]*(?:W/)?"[\x21\x23-\x7e\x80-\xff]*"[ \t]*)*', value):
        return False
    return any(x.removeprefix('W/') == tag.removeprefix('W/') for x in re.findall(r'(?:W/)?"[^"]*"', value))


async def public_response(db, req, response, origin):
    path = req.url.path
    if req.method not in ('GET', 'HEAD') or response.status_code != 200 or not public_path(path):
        return response
    content_type = response.headers.get('Content-Type', '')
    if content_type not in ('text/html; charset=utf-8', 'text/plain; charset=utf-8', 'application/atom+xml; charset=utf-8', 'application/xml; charset=utf-8'):
        return response
    if session_request(req):
        if path == '/robots.txt':
            headers = dict(response.headers)
            headers.pop('content-length', None)
            response = Response(robots(origin, await training_disabled(db)), headers=headers)
        return no_store(response)
    disabled = await training_disabled(db)
    signal = training_signal(disabled)
    body = robots(origin, disabled).encode('utf-8') if path == '/robots.txt' else response.body
    payload = (origin + path + '\0' + content_type + '\0' + signal + '\0').encode('utf-8') + body
    tag = 'W/"sha256-' + hashlib.sha256(payload).hexdigest() + '"'
    headers = dict(response.headers)
    headers.update({'cache-control': PUBLIC_CACHE, 'content-signal': signal, 'etag': tag})
    headers.pop('last-modified', None)
    headers.pop('content-length', None)
    matched = matches_tag(req.headers.get('if-none-match'), tag)
    return Response(None if matched else body, status_code=304 if matched else 200, headers=headers)


def markdown_requested(accept):
    if not accept:
        return False
    ranges = []
    token = r"[a-z0-9!#$%&'*+.^_`|~-]+"
    for part in accept.split(','):
        name, *params = [x.strip() for x in part.strip().lower().split(';')]
        matched = re.fullmatch(r'(' + token + r'|\*)/(' + token + r'|\*)', name)
        if not matched or (matched[1] == '*' and matched[2] != '*'):
            return False
        quality, usable, seen_quality = 1, True, False
        for param in params:
            m = re.fullmatch(r'(' + token + r')=(?:"([^"\r\n]*)"|(' + token + r'))', param)
            if not m:
                return False
            value = m[2] if m[2] is not None else m[3]
            if m[1] == 'q':
                if seen_quality or not re.fullmatch(r'(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)', value):
                    return False
                quality, seen_quality = float(value), True
            elif m[1] != 'charset' or value != 'utf-8':
                usable = False
        ranges.append((matched[1], matched[2], quality, 0 if matched[1] == '*' else 1 if matched[2] == '*' else 2, usable))

    def score(sub):
        matched = [r for r in ranges if r[4] and r[0] in ('text', '*') and r[1] in (sub, '*')]
        specificity = max([-1] + [r[3] for r in matched])
        return max([0] + [r[2] for r in matched if r[3] == specificity])

    return any(r[4] and r[0:2] == ('text', 'markdown') for r in ranges) and score('markdown') > 0 and score('markdown') >= score('html')


def private_agent_path(req):
    path = req.url.path
    return path == '/llms.txt' or bool(re.search(r'/index\.(?:md|jsonld)/?$', path)) or (
        (path == '/' or (public_path(path) and path.endswith('/'))) and markdown_requested(req.headers.get('Accept')))
