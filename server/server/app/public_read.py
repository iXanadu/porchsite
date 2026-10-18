"""Anonymous public validators from current dependency facts, never page bodies."""
import hashlib
import json
import re
import time
from .public_time import plan
from starlette.responses import Response
from .content import validate
from .embed_storage import approved_source_data
from .errors import ApiError
from server.spec.embeds import PERMISSIONS, frame_csp
from . import themes
from .public_http import markdown_path, page_path, page_query, public_path, representation, session_request, matches_tag, PUBLIC_CACHE, training_signal
FACTS_SQL = '''WITH facts0(category,ident,value) AS ( SELECT 'live' AS category,l.item_id AS ident,json_build_array(l.kind,l.slug,l.version,l.published_at,i.created_at,l.data::json->>'status',l.data::json->>'stream',l.data::json->>'external_url',CASE WHEN l.item_id='site' THEN l.data ELSE NULL END,CASE WHEN l.kind='entry' AND COALESCE(l.data::json->>'status','')<>'draft' THEN COALESCE(NULLIF(l.data::json->'event'->>'end',''),l.data::json->'event'->>'start') ELSE NULL END,CASE WHEN l.kind='entry' AND COALESCE(l.data::json->>'status','')<>'draft' THEN l.data::json->>'tags' ELSE NULL END)::text AS value FROM live l LEFT JOIN items i ON i.id=l.item_id
 UNION ALL SELECT 'field',f.key,json_build_array(f.value,f.approved)::text FROM site_fields f JOIN live l ON l.version=f.version AND l.item_id='site'
 UNION ALL SELECT 'embed','site',json_build_array(f.sources,f.approved)::text FROM site_embed_sources f JOIN live l ON l.version=f.version AND l.item_id='site'),
facts1(category,ident,value) AS (SELECT 'streams','site',json_build_array(f.settings,f.approved)::text FROM site_stream_settings f JOIN live l ON l.version=f.version AND l.item_id='site'
 UNION ALL SELECT 'private','site',json_build_array(a.version)::text FROM private_approvals a JOIN live l ON l.version=a.version AND l.item_id='site'
 UNION ALL SELECT 'training','site',json_build_array(a.version)::text FROM training_approvals a JOIN live l ON l.version=a.version AND l.item_id='site'),
facts2(category,ident,value) AS (SELECT 'theme',name,json_build_array(version,sha256)::text FROM themes WHERE name=(SELECT CASE data::json->>'theme' WHEN 'classic' THEN 'personal-homepage' WHEN 'broadsheet' THEN 'product-page' ELSE COALESCE(data::json->>'theme','built-in') END FROM live WHERE item_id='site')
 UNION ALL SELECT 'share',c.item_id,json_build_array(c.version,c.name)::text FROM share_cards c JOIN live l ON l.item_id=c.item_id AND l.version=c.version
 UNION ALL SELECT 'media',name,json_build_array(width,height)::text FROM media WHERE name=(SELECT CASE WHEN data::json->>'hero' ~ '^/media/[0-9a-f]{32}[.](jpg|png|webp)$' THEN substr(data::json->>'hero',8) ELSE NULL END FROM live WHERE item_id='site')
)
SELECT category,ident,value FROM (SELECT * FROM facts0 UNION ALL SELECT * FROM facts1 UNION ALL SELECT * FROM facts2) AS dependency_facts ORDER BY category COLLATE "C",ident COLLATE "C"'''

def decode(rows):
    data=[[r['category'],r['ident'],json.loads(r['value'])] for r in rows]
    for kind,ident,value in data:
        if kind in ('field','embed','streams'):
            value[0]=json.loads(value[0]) if value[1] else None
    for kind,ident,value in data:
        if kind=='live' and len(value)>10 and isinstance(value[10],str):
            value[10]=json.loads(value[10])
    def at(kind,ident='site'):
        return next((r[2] for r in data if r[0]==kind and r[1]==ident),None)
    live=at('live')
    raw=json.loads(live[8]) if live and live[8] else {}
    if live and live[8]:
        live[8]=raw
    extension=at('streams')
    def field(name):
        row=at('field',name)
        return row[0] if row and row[1] else None
    sources=at('embed')
    s=validate('site',{**raw,**(extension[0] if extension and extension[1] else {}),'embed_sources':(sources[0] if sources[1] else []) if sources else raw.get('embed_sources',[]),'private':bool(at('private')) and field('private') is True,'ai_training_disabled':bool(at('training')) and field('ai_training_disabled') is True,'broker':field('broker') or ''})
    streams=s['streams']
    entries=[]
    for kind,ident,v in data:
        if kind!='live' or v[0]!='entry' or v[5]=='draft':
            continue
        st=next((s for s in streams if s['id']==v[6]),streams[0])
        entries.append(dict(id=ident,slug=str(v[1]),stream=st.get('path') or st['id'],streamId=st['id'],page='/'+(st.get('path') or st['id'])+'/'+str(v[1])+'/',external=str(v[7] or ''),endpoint=v[9] if len(v)>9 else None,tags=v[10] if len(v)>10 and v[10] else []))
    theme=themes.ALIASES.get(s['theme'],s['theme'])
    return dict(rows=data,site=s,entries=entries,hasSite=bool(live),themed=themes.is_built_in(theme) or any(r[0]=='theme' and r[1]==theme for r in data),disabled=s['ai_training_disabled'] is True,private=s['private'] is True)

def view_proof(f):
    """Request-owned approved source rows; not an authorization grant."""
    if f['private'] or not f['hasSite']:
        return None
    rows=f['rows']
    live=next((r[2] for r in rows if r[0]=='live' and r[1]=='site'),None)
    if not live or not live[8] or not f.get('site'):
        return None
    return dict(site_version=live[2],raw_site=live[8],site=approved_source_data(live[8],rows),site_rows=[r for r in rows if (r[0]=='live' and r[1]=='site') or r[0] in ('field','embed','streams','private','training')],shares=[dict(item_id=ident,version=v[0],name=v[1]) for kind,ident,v in rows if kind=='share'])

async def facts(db):
    return decode(await db.fetch(FACTS_SQL))

def checked_query(req,base):
    try:
        return page_query(req,base)
    except ValueError as error:
        raise ApiError(400,"invalid",str(error)) from error

def choice(req,f):
    if session_request(req) or req.method not in ('GET','HEAD'):
        return None
    md=markdown_path(req.url.path)
    base=md or req.url.path
    if not (public_path(base) or base=='/llms.txt'):
        return None
    query=checked_query(req,base)
    kind,ctype='html','text/html; charset=utf-8'
    if base=='/llms.txt': kind,ctype='map','text/markdown; charset=utf-8'
    elif base=='/robots.txt': kind,ctype='plain','text/plain; charset=utf-8'
    elif base=='/sitemap.xml': kind,ctype='xml','application/xml; charset=utf-8'
    elif base.endswith('/feed.xml'): kind,ctype='feed','application/atom+xml; charset=utf-8'
    elif page_path(base):
        selected='markdown' if md else representation(req.headers.get('accept'))
        if not selected: return None
        if selected=='markdown': kind,ctype='markdown','text/markdown; charset=utf-8'
    else: return None
    paths=[s.get('path') or s['id'] for s in f['site']['streams']]
    exists=base in ('/','/robots.txt','/sitemap.xml','/llms.txt')
    exists=exists or (base=='/archive/' and f['site']['archive']['enabled'])
    exists=exists or any(not e['external'] and base==f"/{e['stream']}/{e['slug']}/" for e in f['entries'])
    exists=exists or any(base==f'/{p}/feed.xml' or f['themed'] and (base==f'/{p}/' or re.fullmatch('/'+re.escape(p)+'/tags/[a-z0-9-]{1,30}/',base)) for p in paths)
    return dict(base=base,query=query,type=ctype,kind=kind,direct=bool(md)) if exists else None

def tag(f,req,c,release,now=None):
    now=time.time()*1000 if now is None else now
    clock=plan(f,c,now)
    if clock['kind']=='unknown':
        return None
    value=[f['rows'],release,f'{req.url.scheme}://{req.url.netloc}',c['base']+c['query'],c['type'],training_signal(f['disabled']),['public-time/1',clock['kind'],clock['state']]]
    raw=json.dumps(value,ensure_ascii=False,separators=(',',':'),sort_keys=True)
    return 'W/"dep1-'+hashlib.sha256(raw.encode()).hexdigest()+'"'

def headers(f,c,etag,origin):
    h={'Content-Type':c['type'],'Cache-Control':PUBLIC_CACHE,'Content-Signal':training_signal(f['disabled']),'ETag':etag}
    if c['kind']=='html':
        csp="default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" if f['themed'] and c['base']!='/archive/' else "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        if c['base']=='/archive/': csp=csp.replace("form-action 'none'","form-action 'self'")
        h.update({'Content-Security-Policy':frame_csp(csp,f['site']['embed_sources'],origin),'Permissions-Policy':PERMISSIONS,'Referrer-Policy':'strict-origin-when-cross-origin','X-Content-Type-Options':'nosniff','Link':f'<{c["base"]}index.md{c["query"]}>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"','Vary':'Accept'})
    elif c['kind'] in ('markdown','map'):
        h.update({'Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Link':'</llms.txt>; rel="describedby"'})
        if not c['direct'] and c['kind']=='markdown': h['Vary']='Accept'
    return h

def conditional(req,f,c,etag):
    return Response(status_code=304,headers=headers(f,c,etag,f'{req.url.scheme}://{req.url.netloc}')) if etag and matches_tag(req.headers.get('if-none-match'),etag) else None

def unshaped(path):
    return not public_path(path+'/') and not re.fullmatch(r'/[a-z][a-z0-9-]{0,29}/search\.json',path) and not public_path(path) and not markdown_path(path) and path not in ('/archive','/llms.txt') and not re.match(r'^/(?:mcp|authorize|oauth|review|login|setup|recover|invite|passkey|upload|collect|media|static|alerts|app-icon|sw\.js|manifest\.webmanifest|\.well-known)(?:[/.]|$)',path)

def missing():
    return Response('<!doctype html><title>Not found</title>',status_code=404,headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'})


async def miss(req,f,db):
    from .builtin import redirect_for
    from types import SimpleNamespace
    from starlette.requests import Request
    md=markdown_path(req.url.path)
    path=md or req.url.path
    if not (public_path(path) or public_path(path+'/') or path=='/llms.txt'):
        return None
    probe=choice(Request({**req.scope,'headers':[(b'accept',b'text/html')]}),f)
    if probe: return None
    if not md:
        if path=='/archive' and f['site']['archive']['enabled']:
            checked_query(req,'/archive/')
            return Response(status_code=301,headers={'Location':'/archive/'+('?' + req.url.query if req.url.query else ''),'Cache-Control':'no-cache'})
        external=next((e for e in f['entries'] if e['page']==path and e['external']),None)
        if external:
            return Response(status_code=302,headers={'Location':external['external']})
        to=redirect_for(SimpleNamespace(site=f['site'],entries=f['entries']),path)
        if to:
            return Response(status_code=301,headers={'Location':to+('?' + req.url.query if req.url.query else ''),'Cache-Control':'max-age=3600'})
        old=re.fullmatch(r'/e/([a-z0-9-]+)/?',path)
        legacy=next((e for e in f['entries'] if old and e['slug']==old[1]),None)
        if legacy:
            return Response(status_code=301,headers={'Location':legacy['external'] or legacy['page']})
        part=re.fullmatch(r'/([a-z][a-z0-9-]{0,29})/([a-z0-9-]{1,80})/?',path)
        if part:
            ident=await db.fetchval('SELECT item_id FROM slug_history WHERE slug=$1 ORDER BY created_at DESC,version DESC LIMIT 1',part[2])
            entry=next((e for e in f['entries'] if e['id']==ident),None)
            if entry and entry['page']!=path and part[1] in (entry['stream'],entry['streamId'],'e'):
                return Response(status_code=301,headers={'Location':entry['page']+('?' + req.url.query if req.url.query else ''),'Cache-Control':'max-age=3600'})
    return missing()


def candidate(path):
    return not re.match(r'^/(?:review|login|setup|recover|invite|passkey|upload|authorize|oauth|mcp|static|alerts|collect|health|\.well-known)(?:/|$)',path) and bool(public_path(path) or public_path(path+'/') or markdown_path(path) or path=='/llms.txt')
