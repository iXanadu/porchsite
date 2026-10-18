"""AF-7T-C1 transport and multiset controls, paired with the Worker."""
from dataclasses import replace
from pathlib import Path
import json
import pytest
from starlette.requests import Request
from server.app import approvals,content,public_artifacts as artifacts,public_read as read,agent_traffic
from .conftest import TABLES

ORIGIN='https://site.example'
CASES=json.loads((Path(__file__).parents[3]/'spec/fixtures/public-artifacts-cost.json').read_text())

@pytest.fixture(autouse=True)
async def clear(db,app):
    agent_traffic.reset(db)
    await db.execute(f'TRUNCATE {TABLES} RESTART IDENTITY')
    await db.execute('INSERT INTO public_artifact_state(id)VALUES(1)')
    app.settings=replace(app.settings,site_url=ORIGIN,public_artifacts=True)

async def seed(db):
    for kind,data in [('site',{'title':'Cost fixture','archive':{'enabled':True}}),('entry',{'title':'Page','date':'2026-10-18','body':'Published.','tags':['one']})]:
        item=await content.create_item(db,'assistant:test',kind,data,None)
        await approvals.publish_now(db,[{'id':item['id'],'version':item['version']}],'',ORIGIN)

def req():
    return Request({'type':'http','method':'GET','scheme':'https','path':'/','query_string':b'','server':('site.example',443),'headers':[]})

async def test_af_c1_state_once_identity(db):
    await seed(db)
    await db.execute("UPDATE public_artifact_state SET generation='observed-only',revision=37 WHERE id=1")
    legacy=await db.fetch(f'SELECT f.*,(SELECT generation FROM public_artifact_state WHERE id=1) AS generation,(SELECT revision FROM public_artifact_state WHERE id=1) AS revision FROM ({read.FACTS_SQL}) f')
    old=read.decode(legacy)
    f=await read.preparation_facts(db)
    wire=await db.fetch(read.FACTS_STATE_SQL)
    states=[r for r in wire if r['category']=='artifact_state']
    assert len(states)==1 and states[0]['ident']=='site' and json.loads(states[0]['value'])==['observed-only',37]
    assert f['rows']==old['rows'] and f['site']==old['site']
    assert f['raw']==[[r['category'],r['ident'],r['value']] for r in legacy]
    assert f['generation']=='observed-only' and f['revision']==37
    assert read.view_proof(f)==read.view_proof(old)
    c=read.choice(req(),f)
    assert read.tag(f,req(),c,'fixture',0)==read.tag(old,req(),c,'fixture',0)
    assert artifacts.generation(f,'fixture',ORIGIN)==artifacts.generation(old,'fixture',ORIGIN)
    assert 'artifact_state' not in json.dumps(f['rows'])
    assert len(json.dumps([dict(row) for row in wire]))<len(json.dumps([dict(row) for row in legacy]))
    class Off:
        async def fetch(self,sql):
            assert sql==read.FACTS_SQL
            return await db.fetch(sql)
    assert (await read.facts(Off()))['rows']==old['rows']

@pytest.mark.parametrize('n',[0,1,203])
async def test_af_c1_state_once_cardinality(db,n):
    await seed(db)
    rows=await db.fetch(read.FACTS_SQL)
    site=next(r for r in rows if r['category']=='live' and r['ident']=='site')
    entry=next(r for r in rows if r['category']=='live' and r['ident']!='site')
    dependencies=[site]+[{**entry,'ident':'entry-'+str(i)} for i in range(n-1)] if n else []
    class Fake:
        calls=0
        async def fetch(self,sql):
            self.calls+=1
            return [{'category':'artifact_state','ident':'site','value':'["state",1]'},*dependencies]
    fake=Fake()
    f=await read.preparation_facts(fake)
    assert f['rows']==read.decode(dependencies)['rows'] and len(f['raw'])==n and f['generation']=='state' and fake.calls==1

@pytest.mark.parametrize('mode',['absent','duplicate','bad-json','wrong-id','wrong-length','boolean-revision'])
async def test_af_c1_state_once_invalid(db,mode):
    await seed(db)
    rows=await db.fetch(read.FACTS_SQL)
    state={'category':'artifact_state','ident':'site','value':'["state",1]'}
    states=[] if mode=='absent' else [state,state] if mode=='duplicate' else [{**state,'ident':'other' if mode=='wrong-id' else 'site','value':{'bad-json':'{','wrong-length':'["state"]','boolean-revision':'["state",true]'}.get(mode,state['value'])}]
    class Fake:
        async def fetch(self,sql):return [*states,*rows]
    f=await read.preparation_facts(Fake())
    assert f['rows']==read.decode(rows)['rows'] and f['raw']==[[r['category'],r['ident'],r['value']] for r in rows]
    assert f['generation'] is None and f['revision'] is None

async def test_af_c1_state_once_unavailable(db):
    await seed(db)
    class Fake:
        calls=[]
        async def fetch(self,sql):
            self.calls.append(sql)
            if sql==read.FACTS_STATE_SQL:raise RuntimeError('unavailable state')
            return await db.fetch(sql)
    fake=Fake()
    f=await read.preparation_facts(fake)
    assert fake.calls==[read.FACTS_STATE_SQL,read.FACTS_SQL] and f.get('generation') is None
    assert f['rows']==(await read.facts(db))['rows']

@pytest.mark.parametrize('c',CASES,ids=[c['name'] for c in CASES])
async def test_af_c1_grouped_proof(db,http,c):
    await seed(db)
    assert (await http.get('/')).status_code==200
    f=await read.facts(db,True)
    row=await db.fetchrow('SELECT * FROM public_artifacts LIMIT 1')
    raw=[list(x) for x in f['raw']]
    g=row['generation']
    change=c['change']
    if change=='duplicate':raw.append(raw[0])
    elif change=='missing':raw.pop(0)
    elif change=='additional':raw.append(['live','not-current','[]'])
    elif change=='replace':raw[0]=raw[1]
    elif change=='raw':raw[0][2]+=' '
    elif change=='null':raw[0][2]=None
    elif change=='generation':g='wrong'
    elif change=='source':await db.execute("UPDATE live SET data=jsonb_set(data::jsonb,'{title}','\"In place\"')::text WHERE item_id='site'")
    encoded=json.dumps(raw,separators=(',',':'))
    result=await db.fetchrow(artifacts.proof_sql()+' SELECT p.ok,a.body FROM proof p LEFT JOIN public_artifacts a ON p.ok AND a.key=$3 AND a.generation=$2',encoded,g,row['key'])
    assert bool(result['ok'])==c['allowed'] and result['body']==(row['body'] if c['allowed'] else None)
    await db.execute(artifacts.proof_sql()+' INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size) SELECT $3,$2,$4,$5,$6::bigint,$7::integer FROM proof WHERE ok',encoded,g,'conditional-control',row['body'],row['metadata'],row['valid_until'],row['size'])
    assert await db.fetchval("SELECT count(*) FROM public_artifacts WHERE key='conditional-control'")==(1 if c['allowed'] else 0)

@pytest.mark.parametrize('method',['GET','HEAD'])
async def test_af_c2_304_sql_identity(db,method):
    from server.app import routes
    from .test_agent_map import request
    await seed(db)
    first=await routes.handle(request('/'),routes.Context(db,'',None,site_url=ORIGIN,public_artifacts=False))
    tag=first.headers['etag']
    class Capture:
        def __init__(self):self.calls=[]
        def __getattr__(self,name):
            original=getattr(db,name)
            if name not in ('fetch','fetchrow','fetchval','execute','executemany'):return original
            async def run(sql,*args,**kwargs):
                self.calls.append((sql,args,kwargs))
                return await original(sql,*args,**kwargs)
            return run
    for missing in (False,True):
        if missing:await db.execute('ALTER TABLE public_artifact_state RENAME TO absent_copy_state')
        try:
            for match in (tag,'*'):
                async def run(on):
                    counted=Capture();agent_traffic.reset(counted)
                    cx=routes.Context(counted,'',None,site_url=ORIGIN,public_artifacts=on)
                    response=await routes.handle(request('/',method=method,headers={'If-None-Match':match}),cx)
                    await agent_traffic.settle(counted)
                    return response.status_code,response.body,dict(response.headers),counted.calls
                off,on=await run(False),await run(True)
                assert on==off and on[0]==304 and on[1]==b''
                assert sum(sql==read.FACTS_SQL for sql,args,kwargs in on[3])==2
                assert not any('public_artifact' in sql for sql,args,kwargs in on[3])
        finally:
            if missing:await db.execute('ALTER TABLE absent_copy_state RENAME TO public_artifact_state')

async def test_af_c2_visitor_facts_and_preparation(db):
    await seed(db)
    class Fake:
        def __init__(self):self.calls=[]
        async def fetch(self,sql):
            self.calls.append(sql)
            return await db.fetch(sql)
    fake=Fake();f=await read.facts(fake,True)
    assert fake.calls==[read.FACTS_SQL]
    assert f['raw']==[[r['category'],r['ident'],r['value']] for r in await db.fetch(read.FACTS_SQL)]
    assert 'generation' not in f and 'revision' not in f
    fake.calls.clear();await read.preparation_facts(fake)
    assert fake.calls==[read.FACTS_STATE_SQL]

@pytest.mark.parametrize('mode',['missing','generation'])
async def test_af_c2_lookup_state_refusal(db,http,mode):
    await seed(db);assert (await http.get('/')).status_code==200
    f=await read.facts(db,True);old=await db.fetchrow('SELECT * FROM public_artifacts LIMIT 1')
    assert old
    if mode=='missing':await db.execute('DELETE FROM public_artifact_state')
    else:await db.execute("UPDATE public_artifact_state SET generation='stale' WHERE id=1")
    rows=await db.fetch(artifacts.lookup_sql(),json.dumps(f['raw'],separators=(',',':')),old['generation'],old['key'])
    assert len(rows)==1 and rows[0]['facts_ok'] is True and rows[0]['ok'] is False
    assert rows[0]['key'] is None and rows[0]['body'] is None

async def test_af_c2_tuple_drift_priority(db,http):
    from unittest.mock import AsyncMock
    from starlette.responses import Response
    import time
    await seed(db);assert (await http.get('/')).status_code==200
    f=await read.facts(db,True);c=read.choice(req(),f);now=time.time()*1000;tag=read.tag(f,req(),c,'fixture',now)
    await db.execute("UPDATE live SET data=jsonb_set(data::jsonb,'{title}','\"Changed without version\"')::text WHERE item_id='site'")
    await db.execute("UPDATE public_artifact_state SET generation='stale' WHERE id=1")
    render=AsyncMock(return_value=Response('incorrect render'));refresh=AsyncMock(return_value=Response('fresh'))
    response=await artifacts.respond(db,req(),ORIGIN,'fixture',render,dict(facts=f,choice=c,tag=tag,now=now),refresh)
    assert response.body==b'fresh' and refresh.await_count==1 and render.await_count==0
    assert await db.fetchval('SELECT count(*) FROM public_artifacts')==0
    assert await db.fetchval('SELECT generation FROM public_artifact_state WHERE id=1')==''

async def test_af_c2_malformed_returned_proof(db):
    from unittest.mock import AsyncMock
    from starlette.responses import Response
    import time
    await seed(db)
    f=await read.facts(db,True);c=read.choice(req(),f);now=time.time()*1000;tag=read.tag(f,req(),c,'fixture',now)
    class Fake:
        async def fetch(self,sql,*args):
            assert sql==artifacts.lookup_sql()
            return [dict(facts_ok=False,ok=True,generation='stale',revision=0,key='bad',body='must not serve',metadata='[]',valid_until=now+10000)]
    render=AsyncMock(return_value=Response('incorrect render'));refresh=AsyncMock(return_value=Response('fresh'))
    response=await artifacts.respond(Fake(),req(),ORIGIN,'fixture',render,dict(facts=f,choice=c,tag=tag,now=now),refresh)
    assert response.body==b'fresh' and refresh.await_count==1 and render.await_count==0
