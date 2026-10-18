"""Disposable anonymous copies, always behind the router's current access gate."""
import hashlib
import json
import time
from . import public_time
from urllib.parse import urlsplit
from starlette.responses import Response
from .db import transaction

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

def safe_metadata(headers,req,c,stamp):
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
    state=normalized_state(stamp)
    sources=state[2][0][0] if state[2] and state[2][0][1]==1 else []
    origin=f'{req.url.scheme}://{req.url.netloc}'
    policies=HTML_POLICIES+[base.replace("form-action 'none'","form-action 'self'") for base in HTML_POLICIES] if c['base']=='/archive/' else HTML_POLICIES
    allowed=[frame_csp(base,sources,origin) for base in policies]
    if c['base']=='/archive/':
        allowed.extend(base.replace("form-action 'none'","form-action 'self'") for base in HTML_POLICIES)
    return headers.get('content-security-policy') in allowed

async def delivery(db,row,req,c,stamp,release):
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
        if not safe_metadata(headers,req,c,stamp):
            return None
        if headers.get('content-type')!=TYPES[c['type']] or headers.get('cache-control')!=PUBLIC_CACHE or not re.fullmatch(r'W/"dep1-[a-f0-9]{64}"',headers.get('etag','')) or not re.fullmatch(r'search=yes, ai-input=yes, ai-train=(yes|no)',headers.get('content-signal','')):
            return None
    except (ValueError,TypeError):
        return None
    from . import public_read
    f=await public_read.facts(db)
    selected=public_read.choice(req,f)
    if f['private'] or not selected or headers['etag']!=public_read.tag(f,req,selected,release) or headers.get('x-internal-body-sha256')!=digest(row['body']):
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

async def respond(db,req,configured,release,render):
    from . import public_read
    from .public_http import PUBLIC_CACHE
    origin=configured_origin(configured)
    if not origin:
        return await render()
    try:
        selected=choice(req,origin)
    except Exception:
        return await render()
    if not selected:
        return await render()
    c=selected
    try:
        stamp=await snapshot(db)
        if not any(row[0]=='site' for row in json.loads(stamp)[0]):
            return await render()
        generation=digest(dumps([FORMAT,release,origin,normalized_state(stamp)]))
        f=await public_read.facts(db)
        selected=public_read.choice(req,f)
        if f['private'] or not selected:
            return await render()
        clock=public_time.plan(f,selected)
        if clock['kind']=='unknown':
            return await render()
        until=int(display_boundary(time.time()*1000,clock))
        key=dumps([origin,generation,release,c['base']+c['query'],c['type']])
        if len(key.encode())>2048:
            return await render()
        observed=await db.fetchval('SELECT generation FROM public_artifact_state WHERE id=1')
        if observed!=generation:
            async with transaction(db) as conn:
                await conn.execute('INSERT INTO public_artifact_state(id) VALUES(1) ON CONFLICT DO NOTHING')
                await conn.execute('DELETE FROM public_artifacts')
                await conn.execute('UPDATE public_artifact_state SET generation=$1,revision=revision+1 WHERE id=1',generation)
        row=await db.fetchrow('SELECT body,metadata,valid_until FROM public_artifacts WHERE key=$1 AND generation=$2',key,generation)
        if row and row['valid_until']>time.time()*1000:
            if await snapshot(db)==stamp:
                hit=await delivery(db,row,req,c,stamp,release)
                if hit and row['valid_until']>time.time()*1000 and await snapshot(db)==stamp:
                    return hit
            await db.execute('DELETE FROM public_artifacts WHERE key=$1',key)
    except Exception:
        return await render()
    response=await render()
    if response.status_code!=200 or response.headers.get('content-type')!=TYPES[c['type']] or 'set-cookie' in response.headers or response.headers.get('cache-control')!=PUBLIC_CACHE:
        return response
    body=response.body.decode()
    size=len(body.encode())
    metadata=dumps([[name,value] for name,value in response.headers.items() if name in ALLOWED]+[['x-internal-body-sha256',digest(body)]])
    if size>MAX_BODY or len(metadata.encode())>8192 or time.time()*1000>=until:
        return response
    try:
        async with transaction(db) as conn:
            # Serialize quota admission with other fills and invalidation.
            await conn.fetchval('SELECT id FROM public_artifact_state WHERE id=1 FOR UPDATE')
            await conn.execute('DELETE FROM public_artifacts WHERE valid_until<=$1',int(time.time()*1000))
            await conn.execute(f'''INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size)
                SELECT $1,$2,$3,$4,$5::bigint,$6::integer WHERE ({SNAPSHOT})=$7
                AND EXISTS(SELECT 1 FROM public_artifact_state WHERE id=1 AND generation=$2)
                AND $5::bigint>(EXTRACT(EPOCH FROM clock_timestamp())*1000)
                AND (SELECT count(*) FROM public_artifacts WHERE key<>$1)<$8
                AND (SELECT COALESCE(sum(size),0) FROM public_artifacts WHERE key<>$1)+$6<=$9
                ON CONFLICT(key) DO UPDATE SET generation=excluded.generation,body=excluded.body,metadata=excluded.metadata,valid_until=excluded.valid_until,size=excluded.size''',key,generation,body,metadata,until,size,stamp,MAX_ROWS,MAX_BYTES)
        if await snapshot(db)!=stamp:
            return await render()
    except Exception:
        return await render()  # Re-run the live gate after an unverifiable fill.
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
    stamp=await snapshot(db)
    if not any(row[0]=='site' for row in json.loads(stamp)[0]):
        return
    token=str(uuid.uuid4())
    started=int(time.time()*1000)
    await db.execute('INSERT INTO public_artifact_state(id) VALUES(1) ON CONFLICT DO NOTHING')
    claim=await db.fetchval("UPDATE public_artifact_state SET preparing=$1,prepare_until=$2 WHERE id=1 AND (preparing='' OR prepare_until<=$3) RETURNING id",token,started+30000,started)
    if not claim:
        return
    try:
        if await live_private(db) or await snapshot(db)!=stamp:
            return
        pages=list(dict.fromkeys(['/',*await paths()]))
        pages=[p for p in pages if page_path(p) and '?' not in p][:50]
        work=['/','/index.md',*(['/archive/','/archive/index.md'] if '/archive/' in pages else []),'/llms.txt']
        work.extend(path for p in pages if p not in ('/','/archive/') for path in (p,p+'index.md'))
        for path in work:
            if time.time()*1000-started>=250 or await live_private(db) or await snapshot(db)!=stamp:
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
