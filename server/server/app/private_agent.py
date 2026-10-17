"""Private reads are rendered in request memory; no private artifact store."""
import json,re,secrets,time
from starlette.responses import Response
from starlette.requests import Request
from . import owner,read_keys
from .privacy import blank_response,no_store,PrivateContentDenied
from .public_artifacts import snapshot,digest,display_boundary
from .public_http import markdown_path,page_path,page_query,representation,matches_tag,private_agent_path
from .errors import ApiError
PRIVATE_LIGHT='private, no-cache, must-revalidate, no-transform'
def dumps(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'))
async def principal(db,req):
    if 'authorization' in req.headers:
        match=re.fullmatch(r'Bearer[\t ]+(prk_[A-Za-z0-9_-]{32})',req.headers.get('authorization',''),re.I)
        props=await read_keys.lookup(db,match[1]) if match else None
        return {'kind':'key','id':props['readKeyId'],'epoch':str(props['ownerEpoch']),'props':props} if props else None
    kind='owner' if await owner.signed_in(db,req) else 'reader' if await owner.reader_signed_in(db,req) else None
    if not kind:return None
    query,args=owner.session_guard(req,kind)
    await db.execute("DELETE FROM agent_read_session_ids WHERE kind='owner' AND NOT EXISTS(SELECT 1 FROM sessions s JOIN auth_state a ON a.id=1 LEFT JOIN owner_session_auth m ON m.token_hash=s.token_hash WHERE s.token_hash=session_hash AND s.expires_at>$1 AND ((m.token_hash IS NULL AND a.owner_epoch=0) OR (m.epoch=a.owner_epoch AND EXISTS(SELECT 1 FROM passkeys WHERE id=m.credential_id))))",owner.now())
    await db.execute("DELETE FROM agent_read_session_ids WHERE kind='reader' AND NOT EXISTS(SELECT 1 FROM reader_sessions s JOIN readers r ON r.id=s.reader_id JOIN reader_passkeys p ON p.id=s.credential_id AND p.reader_id=r.id WHERE s.token_hash=session_hash AND s.expires_at>$1 AND r.revoked=0 AND r.auth_epoch=s.epoch)",owner.now())
    # One statement fences metadata creation with the canonical live session check.
    await db.execute('INSERT INTO agent_read_session_ids(kind,session_hash,id) SELECT $3,$1,$4 WHERE EXISTS('+query+') ON CONFLICT DO NOTHING',*args,kind,secrets.token_hex(16))
    row=await db.fetchrow('SELECT id FROM agent_read_session_ids WHERE kind=$3 AND session_hash=$1 AND EXISTS('+query+')',*args,kind)
    if not row:return None
    epoch=await db.fetchval('SELECT owner_epoch FROM auth_state WHERE id=1') if kind=='owner' else await db.fetchval('SELECT epoch FROM reader_sessions WHERE token_hash=$1',args[0])
    return {'kind':kind,'id':row['id'],'epoch':str(epoch)} if epoch is not None else None

def identity(p):return [p['kind'],p['id'],p['epoch']]
async def valid(db,req,p):
    fresh=await principal(db,req)
    return bool(fresh and identity(fresh)==identity(p))

async def respond(db,req,render,origin):
    path=req.url.path;base=markdown_path(path);page=page_path(path);copy=path=='/llms.txt' or bool(base)
    if path=='/collect':return None
    candidate=req.method in ('GET','HEAD') and (copy or page)
    if not candidate:
        return blank_response(req) if 'authorization' in req.headers or private_agent_path(req) else None
    selected='markdown' if copy else representation(req.headers.get('accept'))
    if 'authorization' not in req.headers and not copy and selected=='html':return None
    p=await principal(db,req)
    if not p:return blank_response(req)
    async def guard():
        if not await valid(db,req,p):raise PrivateContentDenied()
    get=Request({**req.scope,'method':'GET'},req.receive) if req.method=='HEAD' else req
    try:
        for attempt in range(2):
            await guard();stamp=await snapshot(db);until=display_boundary(time.time()*1000)
            response=await render(get,guard)
            if not await valid(db,req,p):return blank_response(req)
            if await snapshot(db)!=stamp or time.time()*1000>=until:continue
            content_type=response.headers.get('content-type','')
            if response.status_code!=200 or content_type!='text/markdown; charset=utf-8':
                if response.status_code==200 and p.get('props'):await read_keys.used(db,p['props'])
                if not await valid(db,req,p):return blank_response(req)
                if await snapshot(db)!=stamp or time.time()*1000>=until:continue
                return no_store(response)
            body=response.body.decode();canonical=origin+(base or path)+page_query(req,base or path)
            generation=digest(dumps([canonical,content_type,body]))
            tag='W/"ag-sha256-'+digest(dumps(['ag-private/1',p['kind'],p['id'],p['epoch'],canonical,content_type,generation,body]))+'"'
            headers=dict(response.headers)
            for name in ('content-signal','last-modified','age','set-cookie','cdn-cache-control','cloudflare-cdn-cache-control','surrogate-control'):headers.pop(name,None)
            headers.update({'cache-control':PRIVATE_LIGHT,'x-robots-tag':'noindex','etag':tag,'content-length':str(len(body.encode()))})
            if p.get('props'):await read_keys.used(db,p['props'])
            if not await valid(db,req,p):return blank_response(req)
            if await snapshot(db)!=stamp or time.time()*1000>=until:continue
            matched=matches_tag(req.headers.get('if-none-match'),tag)
            if matched:headers.pop('content-length',None)
            return Response(None if matched else body,status_code=304 if matched else 200,headers=headers)
        return Response(None,status_code=503,headers={'Cache-Control':'private, no-store, no-transform'})
    except PrivateContentDenied:return blank_response(req)
    except ApiError as error:
        if error.code=='unauthorized':return blank_response(req)
        raise
