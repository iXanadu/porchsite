"""Optional app-lifecycle public LRU; never an authorization source."""
import asyncio
import hashlib
import json
import math
import time
from collections import OrderedDict
from starlette.responses import Response
from . import public_read, public_time, privacy
from .public_http import session_request, PUBLIC_CACHE
from .public_artifacts import configured_origin

FORMAT='public-responses/1'
MAX_BODY=256*1024
MAX_METADATA=8192
MAX_KEY=2048
MAX_AGE=7200000
MAX_ENTRIES=128
MAX_BYTES=4*1024*1024

def encoded(value):
    return json.dumps(value,ensure_ascii=False,separators=(',',':'))

def key(origin,release,c,tag):
    message=encoded([FORMAT,release,origin,c['base']+c['query'],c['type'],tag])
    url=origin+'/.porchsite-response/'+hashlib.sha256(message.encode()).hexdigest()
    return url if len(url.encode())<=MAX_KEY else None

class Store:
    """One opaque partition per app/pool lifecycle, with bounded concurrent work."""
    def __init__(self):
        self.rows=OrderedDict()
        self.size=0
        self.tasks=set()
        self.closed=False

    def match(self,address):
        row=self.rows.get(address)
        if row is not None:
            self.rows.move_to_end(address)
        return row

    def put(self,address,row):
        if self.closed or len(row['body'])>MAX_BODY:
            return
        old=self.rows.pop(address,None)
        if old is not None:
            self.size-=len(old['body'])
        while self.rows and (len(self.rows)>=MAX_ENTRIES or self.size+len(row['body'])>MAX_BYTES):
            _,old=self.rows.popitem(last=False)
            self.size-=len(old['body'])
        self.rows[address]=row
        self.size+=len(row['body'])

    def schedule(self,work):
        if self.closed or len(self.tasks)>=2:
            return False
        task=asyncio.create_task(work())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return True

    async def drain(self):
        await asyncio.gather(*list(self.tasks),return_exceptions=True)

    async def close(self):
        self.closed=True
        for task in list(self.tasks):
            task.cancel()
        await self.drain()
        self.rows.clear()
        self.size=0

def eligible(req,origin,p):
    return bool(origin and f'{req.url.scheme}://{req.url.netloc}'==origin and req.method in ('GET','HEAD') and not session_request(req) and 'range' not in req.headers and p and p['tag'] and not p['facts']['private'] and p['facts']['hasSite'] and p['choice']['kind'] in ('html','markdown','map'))

def same_choice(a,b):
    return a and all(a[k]==b[k] for k in ('base','query','kind','type'))

async def current(db,req,p,clock):
    fresh=await public_read.facts(db)
    if fresh['private']:
        return 'private'
    return 'same' if fresh['rows']==p['facts']['rows'] and same_choice(public_read.choice(req,fresh),p['choice']) and public_time.valid(clock) else 'changed'

def canonical_headers(p,origin):
    return {k.lower():v for k,v in public_read.headers(p['facts'],p['choice'],p['tag'],origin).items() if k.lower()!='vary'}

def storable(response,p,origin):
    if response.status_code!=200 or response.headers.get('cache-control')!=PUBLIC_CACHE:
        return False
    expected={k.lower():v for k,v in public_read.headers(p['facts'],p['choice'],p['tag'],origin).items()}
    # Starlette supplies representation length; it is never stored as policy.
    return {k:v for k,v in response.headers.items() if k!='content-length'}==expected

def stored(row,p,origin,clock):
    if not isinstance(row,dict) or set(row)!={'body','metadata','headers'}:
        return None
    meta=row['metadata'];body=row['body']
    if not isinstance(meta,list) or len(meta)!=6 or meta[0]!=FORMAT or meta[1]!=p['tag'] or any(type(meta[i]) is not int for i in (2,3,4)) or not isinstance(body,bytes) or len(body)>MAX_BODY or len(body)!=meta[4]:
        return None
    now=time.time()*1000
    if now<meta[2] or now>=meta[3] or not 0<meta[3]-meta[2]<=MAX_AGE or not public_time.valid(clock) or row['headers']!=canonical_headers(p,origin):
        return None
    if len(encoded([meta,row['headers']]).encode())>MAX_METADATA or hashlib.sha256(body).hexdigest()!=meta[5]:
        return None
    return row

async def respond(db,req,configured,release,p,render,refresh,on_hit,store):
    origin=configured_origin(configured)
    if store is None or store.closed or not eligible(req,origin,p):
        return await render()
    clock=public_time.plan(p['facts'],p['choice'],p['now'])
    if not public_time.valid(clock):
        return await render()
    address=key(origin,release,p['choice'],p['tag'])
    if not address:
        return await render()
    try:
        found=store.match(address)
        hit=stored(found,p,origin,clock) if found else None
        if hit:
            proof=await current(db,req,p,clock)
            if proof=='private':
                return privacy.blank_response(req)
            now=time.time()*1000
            if proof!='same' or now<hit['metadata'][2] or now>=hit['metadata'][3]:
                return await refresh()
            on_hit()
            return Response(hit['body'],headers=public_read.headers(p['facts'],p['choice'],p['tag'],origin))
    except Exception:
        pass  # Bad/unavailable derived storage never grants stale access.
    response=await render()
    if req.method!='GET' or not storable(response,p,origin) or len(response.body)>MAX_BODY:
        return response
    async def fill():
        try:
            body=response.body
            now=time.time()*1000
            until=min(p['now']+MAX_AGE,clock['next_change'] if clock['next_change'] is not None else math.inf)
            ttl=math.floor((until-now)/1000)
            if ttl<1 or not public_time.valid(clock):
                return
            meta=[FORMAT,p['tag'],int(p['now']),int(now+ttl*1000),len(body),hashlib.sha256(body).hexdigest()]
            headers=canonical_headers(p,origin)
            if len(encoded([meta,headers]).encode())>MAX_METADATA:
                return
            row=dict(body=body,metadata=meta,headers=headers)
            if await current(db,req,p,clock)!='same' or not public_time.valid(clock) or time.time()*1000>=meta[3]:
                return
            store.put(address,row)
        except Exception:
            pass
    store.schedule(fill)
    return response
