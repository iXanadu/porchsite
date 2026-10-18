"""Published reader projections only: no staged item or owner route loader."""
import base64
from datetime import UTC, datetime
import hashlib
import json
import re
from urllib.parse import parse_qsl, urlencode, urlsplit
from ada_url import URL
from server.spec import theme as views
from . import site, themes, theme, builtin, check as checker
from server.spec.archive import archive_filter as _archive_filter
from .agent_markdown import markdown_document, visible_document_text
from .public_http import markdown_path, page_path
from .read_unicode import read_nfc, read_normalize
from .db import dumps
from .errors import ApiError
from .read_keys import INSTRUCTIONS, restricted


WORD_SPACE = r'[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+'

def _trim_query(value):
    return re.sub(r'^'+WORD_SPACE+'|'+WORD_SPACE+'$', '', value)

def _archive(pairs):
    try:
        return _archive_filter(pairs)
    except ValueError:
        _invalid('Invalid archive filters.')


def _digest(value):
    return hashlib.sha256(dumps(value).encode()).hexdigest()


def _invalid(message='Invalid published read arguments.'):
    raise ApiError(400, 'invalid', message)


def _missing():
    raise ApiError(404, 'not_found', 'No published page at that address.')


def _valid_text(value):
    return isinstance(value, str) and not any(0xd800 <= ord(c) <= 0xdfff for c in value)


def _normalize(value):
    return read_normalize(value)


def _origin(principal):
    raw = principal.get('origin')
    if not isinstance(raw, str):
        _invalid('Site origin is unavailable.')
    try:
        url = URL(raw)
        if url.protocol not in ('https:', 'http:') or url.username or url.password or url.pathname != '/' or url.search or url.hash:
            _invalid('Site origin is unavailable.')
        return url.origin
    except ValueError:
        _invalid('Site origin is unavailable.')


def _timestamp(value):
    if not isinstance(value, str):
        _invalid('Invalid since timestamp.')
    match = re.fullmatch(r'([0-9]{4}-[0-9]{2}-[0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?[Zz]', value)
    if not match or int(match[1][:4]) == 0 or int(match[4]) > 60:
        _invalid('Invalid since timestamp.')
    second = '59' if match[4] == '60' else match[4]
    base = match[1]+'T'+match[2]+':'+match[3]+':'+second
    try:
        datetime.fromisoformat(base+'+00:00')
    except ValueError:
        _invalid('Invalid since timestamp.')
    if match[4] == '60' and (match[2] != '23' or match[3] != '59'):
        _invalid('Invalid since timestamp.')
    fraction = (match[5] or '').rstrip('0')
    return match[1]+'T'+match[2]+':'+match[3]+':'+match[4]+('.'+fraction if fraction else '')+'Z'


def _after(value, bound):
    a, b = _timestamp(value), _timestamp(bound)
    if a[:19] != b[:19]:
        return a[:19] > b[:19]
    fa, fb = a[19:-1].removeprefix('.'), b[19:-1].removeprefix('.')
    width = max(len(fa), len(fb))
    return fa.ljust(width, '0') > fb.ljust(width, '0')


def _maximum(values):
    found = ''
    for value in values:
        if value and (not found or _after(value, found)):
            found = value
    return found


def _limit(args):
    value = args.get('limit', 20)
    if type(value) is not int or not 1 <= value <= 50:
        _invalid('Limit must be between 1 and 50.')
    return value


def _filters(args):
    stream, tag = args.get('stream', ''), args.get('tag', '')
    since = _timestamp(args['since']) if 'since' in args else ''
    if not isinstance(stream, str) or ('stream' in args and not re.fullmatch(r'[a-z][a-z0-9-]{0,29}', stream)) or not isinstance(tag, str) or ('tag' in args and not re.fullmatch(r'[a-z0-9-]{1,30}', tag)):
        _invalid('Invalid published page filters.')
    return dict(stream=stream, tag=tag, since=since)


def _path(value):
    if not _valid_text(value) or len(value.encode()) > 2048 or not value.startswith('/') or value.startswith('//') or re.search(r'[\\#\x00-\x20\x7f]', value):
        _invalid('Invalid published page path.')
    pieces = value.split('?')
    raw = pieces[0]
    if len(pieces) > 2 or '%' in raw or ':' in raw or any(s in ('.', '..') for s in raw.split('/')):
        _invalid('Invalid published page path.')
    base = markdown_path(raw) or raw
    query = ''
    if len(pieces) > 1:
        if base != '/archive/':
            _invalid('Invalid archive filters.')
        selected = _archive(parse_qsl(pieces[1], keep_blank_values=True))
        out = []
        if selected['sort'] != 'date':
            out.append(('sort', selected['sort']))
        for name in ('stream', 'tag'):
            if selected[name]:
                out.append((name, selected[name]))
        query = '?'+urlencode(out) if out else ''
    return base, base+query


def _encode(cursor):
    return 'ag2_'+base64.urlsafe_b64encode(dumps(cursor).encode()).decode().rstrip('=')


def _cursor(value=None):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 2048 or not re.fullmatch(r'ag2_[A-Za-z0-9_-]+', value):
        _invalid('Invalid cursor.')
    try:
        payload = value[4:]
        cursor = json.loads(base64.urlsafe_b64decode(payload+'='*((4-len(payload)%4)%4)))
        if not isinstance(cursor, dict) or len(cursor) != 5 or type(cursor.get('v')) is not int or cursor['v'] != 1 or not isinstance(cursor.get('last'), str) or re.search(r'[\\%#?\x00-\x20\x7f]', cursor['last']) or not page_path(cursor['last']) or not all(isinstance(cursor.get(k), str) and re.fullmatch(r'[a-f0-9]{64}', cursor[k]) for k in ('filter', 'corpus', 'principal')):
            _invalid('Invalid cursor.')
        ordered = dict(v=1, last=cursor['last'], filter=cursor['filter'], corpus=cursor['corpus'], principal=cursor['principal'])
        if _encode(ordered) != value:
            _invalid('Invalid cursor.')
        return ordered
    except (ValueError, UnicodeError, TypeError, KeyError):
        _invalid('Invalid cursor.')


def _binding(principal):
    return _digest(['published_read', principal.get('readKeyId'), principal.get('ownerEpoch')] if restricted(principal) else ['writer', principal.get('clientId') or '', principal.get('client') or ''])


def _clock():
    return datetime.now(UTC)


async def _snapshot(db, principal):
    origin = _origin(principal)
    v = await site.live_view(db)
    v.now = _clock()
    t = await themes.load(db, str(v.site['theme']))
    installed = await db.fetchval('SELECT installed_at FROM themes WHERE name=$1', str(v.site['theme'])) or ''
    ids = {e['id'] for e in v.entries}
    stamp = _digest([origin, v.site, v.entries, v.cards, v.notes, v.approved_at, v.updated, list(v.hero_size), {k: value for k, value in v.share_cards.items() if k in ids}, t, installed])
    changed = _maximum([*v.approved_at.values(), installed])
    return dict(origin=origin, v=v, t=t, installed=installed, stamp=stamp, changed=changed, at=v.now.timestamp()*1000, by_path={e['page']: e for e in v.entries})


def _paths(s):
    v, t, changed, installed = s['v'], s['t'], s['changed'], s['installed']
    if not v.approved_at.get('site'):
        return []
    pages = [dict(path='/', title=str(v.site['title']), changed_at=changed)]
    if v.site.get('archive', {}).get('enabled'):
        pages.append(dict(path='/archive/', title=str(v.site['archive']['title']), changed_at=changed))
    if t:
        for stream in views.streams(v.site):
            pages.append(dict(path=stream['archive_url'], title=stream['title'], changed_at=changed))
            for tag in dict.fromkeys(tag for e in v.entries if e['stream'] == stream['id'] for tag in e['tags']):
                pages.append(dict(path=stream['archive_url']+'tags/'+tag+'/', title=tag, changed_at=changed))
    for e in v.entries:
        if not e.get('external_url'):
            pages.append(dict(path=e['page'], title=str(e['title']), changed_at=_maximum([v.approved_at['site'], v.approved_at.get(e['id'], ''), installed])))
    return sorted({p['path']: p for p in pages}.values(), key=lambda p: read_nfc(p['path']).encode())


async def _document(s, path):
    v, t, origin = s['v'], s['t'], s['origin']
    base, _ = _path(path)
    if not v.approved_at.get('site') or not page_path(base):
        return None
    release, policy = site.release_of(v), dict(sources=v.site.get('embed_sources'), origin=origin)
    e = s['by_path'].get(base)
    html = None
    if base == '/archive/' and v.site.get('archive', {}).get('enabled'):
        html = builtin.all_archive_page(v, _archive(parse_qsl(urlsplit(path).query, keep_blank_values=True)), origin, bool(t)).body.decode()
    elif base == '/':
        html = theme.render(t, 'home', views.home_view(v, release, origin), policy) if t else builtin.home(v, origin).body.decode()
    elif e and not e.get('external_url'):
        html = theme.render(t, 'entry', views.entry_view(v, e, release, origin), policy) if t else builtin.entry_page(v, base, origin).body.decode()
    elif t:
        match = re.fullmatch(r'/([a-z][a-z0-9-]{0,29})/(?:tags/([a-z0-9-]{1,30})/)?', base)
        if match:
            view = views.archive_view(v, match[1], release, origin, match[2])
            if view:
                html = theme.render(t, 'tag' if match[2] else 'archive', view, policy)
    if html is None:
        return None
    canonical = origin+path
    doc = markdown_document(html, canonical)
    return dict(path=path, canonical_url=canonical, title=doc['title'], changed_at=_maximum([v.approved_at['site'], v.approved_at.get(e['id'], ''), s['installed']]) if e else s['changed'], markdown=doc['markdown'], text=visible_document_text(html), tags=list(e['tags']) if e else [], **({'date': str(e['date'])} if e else {}))


async def _unchanged(db, s, principal):
    current = await _snapshot(db, principal)
    return int(_clock().timestamp()//60) == int(s['at']//60000) and current['stamp'] == s['stamp']


async def _corpus(db, principal):
    s = await _snapshot(db, principal)
    docs = []
    for p in _paths(s):
        doc = await _document(s, p['path'])
        if doc:
            docs.append(doc)
    return s, docs, _digest([[d['path'], d['title'], d['changed_at'], d['text']] for d in docs])


async def _slice(db, args, principal, search_query=None):
    limit = _limit(args)
    selected_filter = _filters(args) if search_query is None else None
    cursor = _cursor(args['cursor']) if 'cursor' in args else None
    if 'cursor' in args and args['cursor'] is None:
        _invalid('Invalid cursor.')
    query = ['pages_list', selected_filter] if search_query is None else ['search', search_query]
    filter_digest, principal_digest = _digest(query), _binding(principal)
    if cursor and (cursor['filter'] != filter_digest or cursor['principal'] != principal_digest):
        _invalid('Invalid cursor.')
    for attempt in range(1 if cursor else 2):
        s, docs, generation = await _corpus(db, principal)
        if cursor and cursor['corpus'] != generation:
            raise ApiError(409, 'cursor_stale', 'Published pages changed. Start a new listing.')
        rows = docs
        if selected_filter is not None:
            f = selected_filter
            if f['stream'] or f['tag'] or f['since']:
                def keep(doc):
                    e = s['by_path'].get(doc['path'])
                    return e is not None and not e.get('external_url') and (not f['stream'] or e['stream'] == f['stream']) and (not f['tag'] or f['tag'] in e['tags']) and (not f['since'] or _after(doc['changed_at'], f['since']))
                rows = [d for d in docs if keep(d)]
        else:
            terms = re.split(WORD_SPACE, search_query)
            def matches(doc):
                text = _normalize(doc['title']+' '+doc['text'])
                return all(term in text for term in terms)
            rows = [d for d in docs if matches(d)]
        if cursor and not any(d['path'] == cursor['last'] for d in rows):
            _invalid('Invalid cursor.')
        remaining = [d for d in rows if read_nfc(d['path']).encode() > cursor['last'].encode()] if cursor else rows
        selected = remaining[:limit]
        next_cursor = _encode(dict(v=1, last=selected[-1]['path'], filter=filter_digest, corpus=generation, principal=principal_digest)) if len(remaining) > limit else None
        if not await _unchanged(db, s, principal):
            if cursor:
                raise ApiError(409, 'cursor_stale', 'Published pages changed. Start a new listing.')
            continue
        return s, selected, next_cursor
    raise ApiError(409, 'content_changed', 'Published pages changed. Try again.')


async def pages_list(db, args, principal):
    _, selected, next_cursor = await _slice(db, args, principal)
    return dict(pages=[{k: d[k] for k in ('path', 'title', 'changed_at')} for d in selected], next_cursor=next_cursor)


async def search(db, args, principal):
    value = args.get('query')
    if not _valid_text(value):
        _invalid('Query must contain 1 to 200 Unicode scalar values.')
    trimmed = _trim_query(value)
    query = ' '.join(re.split(WORD_SPACE, _normalize(trimmed)))
    if not query or len(trimmed) > 200:
        _invalid('Query must contain 1 to 200 Unicode scalar values.')
    _, selected, next_cursor = await _slice(db, args, principal, query)
    return dict(results=[dict(path=d['path'], title=d['title'], excerpt=d['text'][:240]) for d in selected], next_cursor=next_cursor)


async def page_get(db, args, principal):
    _, path = _path(args.get('path'))
    for _ in range(2):
        s = await _snapshot(db, principal)
        doc = await _document(s, path)
        if doc is None:
            _missing()
        if await _unchanged(db, s, principal):
            return {k: doc[k] for k in ('path', 'canonical_url', 'title', 'date', 'tags', 'markdown') if k in doc}
    raise ApiError(409, 'content_changed', 'Published pages changed. Try again.')


async def state(db, args, principal=None):
    if args.get('full') is True or 'ids' in args:
        raise ApiError(403, 'unauthorized', 'Only the published page listing is available.')
    s, selected, next_cursor = await _slice(db, {}, principal or {})
    guide = dict(scope='published_read', tools=['site_state', 'site_check', 'page_get', 'pages_list', 'search'], description=INSTRUCTIONS)
    revision = 'published-read-'+_digest(guide)
    included = (args.get('guide') or {}).get('known_revision') != revision
    return dict(scope='published_read', site={'title': str(s['v'].site['title']) if s['v'].approved_at.get('site') else ''}, pages=[{k: d[k] for k in ('path', 'title', 'changed_at')} for d in selected], next_cursor=next_cursor, **({'read_guide': guide} if included else {}), **({'guide': dict(revision=revision, included=included)} if 'guide' in args else {}))


async def check(db, args, origin):
    v = await site.live_view(db)
    text = dumps({'site': v.site, 'entries': v.entries, 'cards': v.cards, 'notes': v.notes})
    names = {r['name'] for r in await db.fetch('SELECT name FROM media') if '/media/'+r['name'] in text}
    return checker.check_site_deep(v, names, await themes.load(db, str(v.site['theme'])), origin) if args.get('deep') else checker.check_site(v, names)
