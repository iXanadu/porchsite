"""Disposable anonymous copies, always behind the router's current access gate."""
import hashlib
import json
import time
from . import public_time
from urllib.parse import urlsplit
from starlette.responses import Response
from .db import transaction

# Legacy fixture encoding; live lookup/admission uses THIN_FORMAT.
FORMAT = 'public-artifacts/1'
MAX_BODY, MAX_ROWS, MAX_BYTES = 256*1024, 128, 4*1024*1024
QUERIES = [
    'SELECT l.item_id,l.kind,l.slug,l.version,l.published_at,i.created_at FROM live l LEFT JOIN items i ON i.id=l.item_id ORDER BY l.item_id COLLATE "C"',
    'SELECT f.key,f.value,f.approved FROM site_fields f JOIN live l ON l.version=f.version AND l.item_id=\'site\' ORDER BY f.key COLLATE "C"',
    "SELECT f.sources,f.approved FROM site_embed_sources f JOIN live l ON l.version=f.version AND l.item_id='site'",
    "SELECT f.settings,f.approved FROM site_stream_settings f JOIN live l ON l.version=f.version AND l.item_id='site'",
    "SELECT a.version FROM private_approvals a JOIN live l ON l.version=a.version AND l.item_id='site'",
    "SELECT a.version FROM training_approvals a JOIN live l ON l.version=a.version AND l.item_id='site'",
    "SELECT name,version,sha256 FROM themes WHERE name=(SELECT CASE data::json->>'theme' WHEN 'classic' THEN 'personal-homepage' WHEN 'broadsheet' THEN 'product-page' ELSE COALESCE(data::json->>'theme','personal-homepage') END FROM live WHERE item_id='site') ORDER BY name COLLATE \"C\"",
    'SELECT c.item_id,c.version,c.name FROM share_cards c JOIN live l ON l.item_id=c.item_id AND l.version=c.version ORDER BY c.item_id COLLATE "C"',
    "SELECT m.name,m.width,m.height FROM media m WHERE EXISTS (SELECT 1 FROM live l WHERE strpos(l.data,'/media/'||m.name)>0) ORDER BY m.name COLLATE \"C\"",
]
COLUMNS = [['item_id','kind','slug','version','published_at','created_at'],['key','value','approved'],['sources','approved'],['settings','approved'],['version'],['version'],['name','version','sha256'],['item_id','version','name'],['name','width','height']]
SNAPSHOT = 'json_build_array('+','.join('(SELECT COALESCE(json_agg(json_build_array('+','.join(columns)+")),'[]'::json) FROM ("+query+') AS dependency)' for query,columns in zip(QUERIES,COLUMNS))+')::text'

def dumps(value):
    return json.dumps(value,ensure_ascii=False,separators=(',',':'))

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

def normalized_state(stamp):
    state=json.loads(stamp)
    for table,column in [(1,1),(2,0),(3,0)]:
        for row in state[table]:
            row[column]=json.loads(row[column])
    def ordered(value):
        if isinstance(value,list):
            return [ordered(v) for v in value]
        if isinstance(value,dict):
            return {k:ordered(value[k]) for k in sorted(value)}
        return value
    return ordered(state)

async def snapshot(db):
    return await db.fetchval('SELECT '+SNAPSHOT)

async def invalidate(db):
    """Called inside the same transaction as an effective public mutation."""
    await db.fetchval('SELECT id FROM public_artifact_state WHERE id=1 FOR UPDATE')
    await db.execute('DELETE FROM public_artifacts')
    await db.execute("UPDATE public_artifact_state SET generation='',revision=revision+1,preparing='',prepare_until=0 WHERE id=1")

async def clear(db):
    async with transaction(db) as c:
        await invalidate(c)

ALLOWED = {'x-internal-body-sha256','content-type','content-security-policy','permissions-policy','x-content-type-options','referrer-policy','link','content-signal','etag','cache-control','vary'}
TYPES = {'html':'text/html; charset=utf-8','markdown':'text/markdown; charset=utf-8','map':'text/markdown; charset=utf-8'}

def configured_origin(value):
    if not value:
        return None
    try:
        u=urlsplit(value)
        if u.scheme not in ('https','http') or not u.hostname or u.username or u.password or u.path not in ('','/') or u.query or u.fragment or '%' in u.hostname:
            return None
        host=u.hostname.encode('idna').decode().lower()
        host='['+host+']' if ':' in host else host
        port=u.port
        return f'{u.scheme}://{host}'+(':'+str(port) if port is not None and port!={'https':443,'http':80}[u.scheme] else '')
    except ValueError:
        return None

def display_boundary(now,plan=None):
    return now if plan and plan['kind']=='unknown' else min(now+86400000,plan['next_change'] if plan and plan['next_change'] is not None else float('inf'))

def choice(req,origin):
    from .public_http import markdown_path,page_path,page_query,representation,session_request
    u=req.url
    if req.method not in ('GET','HEAD') or session_request(req) or f'{u.scheme}://{u.netloc}'!=origin:
        return None
    if u.path=='/llms.txt':
        return {'type':'map','base':'/llms.txt','query':'','direct':True}
    md=markdown_path(u.path)
    base=md or u.path
    if not page_path(base):
        return None
    selected='markdown' if md else representation(req.headers.get('accept'))
    return {'type':selected,'base':base,'query':page_query(req,base),'direct':bool(md)} if selected else None

HTML_POLICIES = [
    "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
]

def safe_metadata(headers,req,c,f):
    from server.spec.embeds import frame_csp,PERMISSIONS
    description='</llms.txt>; rel="describedby"'
    md=c['type']!='html'
    if headers.get('x-content-type-options')!='nosniff' or headers.get('vary','Accept')!='Accept':
        return False
    link=description if md else f"<{c['base']}index.md{c['query']}>; rel=\"alternate\"; type=\"text/markdown\", {description}"
    if headers.get('link')!=link:
        return False
    if md:
        return headers.get('content-security-policy')=="default-src 'none'; base-uri 'none'; frame-ancestors 'none'" and 'permissions-policy' not in headers and 'referrer-policy' not in headers
    if headers.get('permissions-policy')!=PERMISSIONS or headers.get('referrer-policy')!='strict-origin-when-cross-origin':
        return False
    sources=f['site']['embed_sources']
    origin=f'{req.url.scheme}://{req.url.netloc}'
    policies=HTML_POLICIES+[base.replace("form-action 'none'","form-action 'self'") for base in HTML_POLICIES] if c['base']=='/archive/' else HTML_POLICIES
    allowed=[frame_csp(base,sources,origin) for base in policies]
    if c['base']=='/archive/':
        allowed.extend(base.replace("form-action 'none'","form-action 'self'") for base in HTML_POLICIES)
    return headers.get('content-security-policy') in allowed

async def delivery(row,req,c,f,etag):
    import re
    from .public_http import PUBLIC_CACHE,matches_tag
    if len(row['body'].encode())>MAX_BODY or len(row['metadata'].encode())>8192:
        return None
    try:
        entries=json.loads(row['metadata'])
        if not isinstance(entries,list) or any(not isinstance(p,list) or len(p)!=2 or any(not isinstance(x,str) for x in p) or p[0] not in ALLOWED for p in entries):
            return None
        if len({p[0] for p in entries})!=len(entries):
            return None
        headers=dict(entries)
        if not safe_metadata(headers,req,c,f):
            return None
        if headers.get('content-type')!=TYPES[c['type']] or headers.get('cache-control')!=PUBLIC_CACHE or not re.fullmatch(r'W/"dep1-[a-f0-9]{64}"',headers.get('etag','')) or not re.fullmatch(r'search=yes, ai-input=yes, ai-train=(yes|no)',headers.get('content-signal','')):
            return None
    except (ValueError,TypeError):
        return None
    from . import public_read
    if headers['etag']!=etag or headers.get('content-signal')!=public_read.headers(f,{**c,'type':TYPES[c['type']],'kind':c['type']},etag,f'{req.url.scheme}://{req.url.netloc}').get('Content-Signal') or headers.get('x-internal-body-sha256')!=digest(row['body']):
        return None
    headers.pop('x-internal-body-sha256',None)
    if c['type']=='html' or (c['type']=='markdown' and not c['direct']):
        headers['vary']='Accept'
    else:
        headers.pop('vary',None)
    match=matches_tag(req.headers.get('if-none-match'),headers['etag'])
    if req.method=='HEAD' and not match:
        headers['content-length']=str(len(row['body'].encode()))
    return Response(None if match or req.method=='HEAD' else row['body'],status_code=304 if match else 200,headers=headers)

THIN_FORMAT='public-artifacts/2'
MAX_FACTS=128*1024
PROOF_SQL='''WITH current_facts AS ({facts}),
 expected AS (SELECT e->>0 AS category,e->>1 AS ident,e->>2 AS value FROM json_array_elements($1::json) e),
 current_counts AS MATERIALIZED (SELECT category,ident,value,count(*) AS n FROM current_facts GROUP BY category,ident,value),
 expected_counts AS MATERIALIZED (SELECT category,ident,value,count(*) AS n FROM expected GROUP BY category,ident,value),
 proof AS (SELECT NOT EXISTS(SELECT category,ident,value,n FROM current_counts EXCEPT SELECT category,ident,value,n FROM expected_counts)
 AND NOT EXISTS(SELECT category,ident,value,n FROM expected_counts EXCEPT SELECT category,ident,value,n FROM current_counts)
 AND EXISTS(SELECT 1 FROM public_artifact_state WHERE id=1 AND generation=$2) AS ok)'''

def proof_sql():
    from .public_read import FACTS_RELATION
    return PROOF_SQL.format(facts=FACTS_RELATION)

def lookup_sql():
    from .public_read import FACTS_RELATION
    return f'''WITH current_facts AS ({FACTS_RELATION}),
 expected AS (SELECT e->>0 AS category,e->>1 AS ident,e->>2 AS value FROM json_array_elements($1::json) e),
 current_counts AS MATERIALIZED (SELECT category,ident,value,count(*) AS n FROM current_facts GROUP BY category,ident,value),
 expected_counts AS MATERIALIZED (SELECT category,ident,value,count(*) AS n FROM expected GROUP BY category,ident,value),
 tuple_proof AS (SELECT NOT EXISTS(SELECT category,ident,value,n FROM current_counts EXCEPT SELECT category,ident,value,n FROM expected_counts)
 AND NOT EXISTS(SELECT category,ident,value,n FROM expected_counts EXCEPT SELECT category,ident,value,n FROM current_counts) AS facts_ok),
 copy_state AS MATERIALIZED (SELECT generation,revision FROM public_artifact_state WHERE id=1),
 proof AS (SELECT t.facts_ok,s.generation,s.revision,
 COALESCE(s.generation IS NOT NULL AND s.revision IS NOT NULL AND t.facts_ok AND s.generation=$2,false) AS ok
 FROM tuple_proof t LEFT JOIN copy_state s ON 1=1)
 SELECT p.facts_ok,p.generation,p.revision,p.ok,a.key,a.body,a.metadata,a.valid_until FROM proof p LEFT JOIN public_artifacts a ON p.ok AND a.key=$3 AND a.generation=$2'''

def generation(f,release,origin):
    return digest(json.dumps([THIN_FORMAT,release,origin,f['rows']],ensure_ascii=False,separators=(',',':'),sort_keys=True))

async def synchronize(db,g):
    async with transaction(db) as conn:
        await conn.execute('INSERT INTO public_artifact_state(id) VALUES(1) ON CONFLICT DO NOTHING')
        await conn.execute('DELETE FROM public_artifacts')
        await conn.execute("UPDATE public_artifact_state SET generation=$1,revision=revision+1,preparing='',prepare_until=0 WHERE id=1",g)

async def respond(db,req,configured,release,render,captured=None,refresh=None):
    from . import public_read
    from .public_http import PUBLIC_CACHE
    refresh=refresh or render
    origin=configured_origin(configured)
    if not origin:
        return await render()
    try:
        c=choice(req,origin)
    except Exception:
        return await render()
    if not c:
        return await render()
    try:
        f=captured['facts'] if captured else await public_read.facts(db,True)
        selected=captured['choice'] if captured else public_read.choice(req,f)
        if f['private'] or not selected or not f['hasSite']:
            return await refresh()
        at=captured['now'] if captured else time.time()*1000
        clock=public_time.plan(f,selected,at)
        etag=captured['tag'] if captured else public_read.tag(f,req,selected,release,at)
        if not etag or clock['kind']=='unknown' or not public_time.valid(clock):
            return await refresh()
        raw=dumps(f.get('raw'))
        if not f.get('raw') or len(raw.encode())>MAX_FACTS:
            return await render()
        g=generation(f,release,origin)
        until=int(display_boundary(time.time()*1000,clock))
        key=dumps([THIN_FORMAT,origin,g,release,c['base']+c['query'],c['type'],etag])
        if len(key.encode())>2048:
            return await render()
        found=await db.fetch(lookup_sql(),raw,g,key)
        if len(found)!=1:
            raise ValueError('Unavailable copy proof')
        row=found[0]
        state=isinstance(row['generation'],str) and type(row['revision']) is int
        if type(row['facts_ok']) is not bool or type(row['ok']) is not bool or row['ok']!=(row['facts_ok'] and state and row['generation']==g):
            raise ValueError('Unavailable copy proof')
        if row['key'] is not None and row['key']!=key:
            raise ValueError('Unavailable copy proof')
        if (not row['ok'] or row['key'] is None) and any(row[k] is not None for k in ('key','body','metadata','valid_until')):
            raise ValueError('Unavailable copy proof')
        if not row['facts_ok']:
            await clear(db)
            return await refresh()
        if not row['ok']:
            await synchronize(db,g)
        elif row['key']:
            if row['valid_until']>time.time()*1000 and public_time.valid(clock):
                hit=await delivery(row,req,c,f,etag)
                if hit is not None and row['valid_until']>time.time()*1000 and public_time.valid(clock):
                    return hit
            await db.execute('DELETE FROM public_artifacts WHERE key=$1',key)
    except Exception:
        return await refresh()
    response=await render()
    if response.status_code!=200 or response.headers.get('content-type')!=TYPES[c['type']] or 'set-cookie' in response.headers or response.headers.get('cache-control')!=PUBLIC_CACHE or response.headers.get('etag')!=etag:
        return response
    body=response.body.decode()
    size=len(body.encode())
    metadata=dumps([[name,value] for name,value in response.headers.items() if name in ALLOWED]+[['x-internal-body-sha256',digest(body)]])
    if time.time()*1000>=until or not public_time.valid(clock):
        return await refresh()
    if size>MAX_BODY or len(metadata.encode())>8192:
        return response
    try:
        async with transaction(db) as conn:
            # Serialize fills with quota admission/invalidation. This counted
            # DML locks the singleton without changing its identity or revision.
            locked=await conn.fetchval('UPDATE public_artifact_state SET revision=revision WHERE id=1 AND generation=$1 RETURNING id',g)
            if not locked:
                inserted=None
            else:
                inserted=await conn.fetchval(proof_sql()+''', expired AS (DELETE FROM public_artifacts WHERE key<>$3 AND valid_until<=$10::bigint RETURNING key)
                INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size)
                SELECT $3,$2,$4,$5,$6::bigint,$7::integer FROM proof WHERE ok
                AND $6::bigint>(EXTRACT(EPOCH FROM clock_timestamp())*1000)
                AND (SELECT count(*) FROM public_artifacts WHERE key<>$3 AND valid_until>$10::bigint)<$8::integer
                AND (SELECT COALESCE(sum(size),0) FROM public_artifacts WHERE key<>$3 AND valid_until>$10::bigint)+$7::integer<=$9::integer
                AND (SELECT count(*) FROM expired)>=0
                ON CONFLICT(key) DO UPDATE SET generation=excluded.generation,body=excluded.body,metadata=excluded.metadata,valid_until=excluded.valid_until,size=excluded.size RETURNING key''',raw,g,key,body,metadata,until,size,MAX_ROWS,MAX_BYTES,int(time.time()*1000))
        if not inserted or not public_time.valid(clock):
            return await refresh()
    except Exception:
        return await refresh()
    return response


async def public_change(db, sql, *args):
    async with transaction(db) as c:
        result = await c.execute(sql, *args)
        await invalidate(c)
        return result


async def prepare(db,configured,release,render_path,paths):
    """Public-only bounded build-ahead; no actual HTTP visit/accounting."""
    import uuid
    from .privacy import live_private
    from .public_http import page_path
    origin=configured_origin(configured)
    if not origin or await live_private(db):
        return
    from . import public_read
    initial=await public_read.preparation_facts(db)
    if initial['private'] or not initial['hasSite']:
        return
    stamp=initial['rows']
    g=generation(initial,release,origin)
    if initial.get('generation')!=g:
        await synchronize(db,g)
    token=str(uuid.uuid4())
    started=int(time.time()*1000)
    await db.execute('INSERT INTO public_artifact_state(id) VALUES(1) ON CONFLICT DO NOTHING')
    claim=await db.fetchval("UPDATE public_artifact_state SET preparing=$1,prepare_until=$2 WHERE id=1 AND (preparing='' OR prepare_until<=$3) RETURNING id",token,started+30000,started)
    if not claim:
        return
    try:
        if await live_private(db) or (await public_read.facts(db))['rows']!=stamp:
            return
        pages=list(dict.fromkeys(['/',*await paths()]))
        pages=[p for p in pages if page_path(p) and '?' not in p][:50]
        work=['/','/index.md',*(['/archive/','/archive/index.md'] if '/archive/' in pages else []),'/llms.txt']
        work.extend(path for p in pages if p not in ('/','/archive/') for path in (p,p+'index.md'))
        for path in work:
            if time.time()*1000-started>=250 or await live_private(db) or (await public_read.facts(db))['rows']!=stamp:
                break
            request=request_for(origin,path)
            async def render():
                return await render_path(request)
            await respond(db,request,origin,release,render)
    finally:
        await db.execute("UPDATE public_artifact_state SET preparing='',prepare_until=0 WHERE id=1 AND preparing=$1",token)


def request_for(origin,path):
    from starlette.requests import Request
    u=urlsplit(origin+path)
    return Request({'type':'http','method':'GET','scheme':u.scheme,'path':u.path,'raw_path':u.path.encode(),'query_string':b'','headers':[(b'host',u.netloc.encode())],'server':(u.hostname,u.port or (443 if u.scheme=='https' else 80))})


_jobs=set()

def schedule(db,origin,release,render_path,paths):
    import asyncio
    async def run():
        try:
            await prepare(db,origin,release,render_path,paths)
        except Exception:
            pass  # Preparation is never required for successful publication.
    task=asyncio.create_task(run())
    _jobs.add(task)
    task.add_done_callback(_jobs.discard)


async def drain():
    import asyncio
    current=[t for t in _jobs if t.get_loop() is asyncio.get_running_loop()]
    if current:
        await asyncio.gather(*current,return_exceptions=True)
