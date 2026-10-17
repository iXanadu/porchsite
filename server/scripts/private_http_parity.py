"""Native private HTTP parity against disposable published sample databases."""
import asyncio,hashlib,json,os,secrets,sys
from pathlib import Path
from urllib.parse import urlsplit,urlunsplit
import asyncpg
from contextlib import nullcontext
from datetime import datetime,UTC,timedelta
from starlette.requests import Request
from server.app import content,routes,site
from server.app.db import apply_schema
from server.app.embed_storage import stored_data
ROOT=Path(__file__).resolve().parents[2]
FIELDS=['content-type','cache-control','content-security-policy','etag','link','vary','x-robots-tag','content-signal','last-modified']
async def main(output,names):
    parts=urlsplit(os.environ['PORCHSITE_TEST_DSN']);name='porchsite_private_parity_'+secrets.token_hex(4)
    assert parts.hostname=='localhost' and parts.port==5433
    admin=await asyncpg.connect(os.environ['PORCHSITE_TEST_DSN']);pool=None
    await admin.execute(f'CREATE DATABASE "{name}"')
    try:
        pool=await asyncpg.create_pool(urlunsplit((parts.scheme,parts.netloc,'/'+name,'','')),min_size=1,max_size=4)
        await apply_schema(pool)
        proposed=site.proposed_view
        fixed=datetime.fromisoformat(os.environ.get('NOW','2026-10-15T15:30:00Z').replace('Z','+00:00'))
        async def fixed_view(*args,**kwargs):
            view=await proposed(*args,**kwargs);view.now=fixed;return view
        site.proposed_view=fixed_view
        with nullcontext():
            for look in names:
                sample=json.loads((ROOT/'themes'/look/'sample.json').read_text())
                await pool.execute('TRUNCATE items,live,themes,site_embed_sources,site_fields,private_approvals,site_stream_settings,training_approvals,agent_read_keys')
                rows=[{'id':'site','kind':'site','slug':None,'data':content.validate('site',{**sample['site'],'theme':look,'private':True})}]+[{'id':'i'+str(i),'kind':x['kind'],'slug':x.get('slug','item-'+str(i)) if x['kind']=='entry' else None,'data':content.validate(x['kind'],x['data'])} for i,x in enumerate(sample['items'])]
                for i,row in enumerate(rows):
                    at=(datetime(2026,10,10,12,tzinfo=UTC)+timedelta(seconds=i)).isoformat(timespec='milliseconds').replace('+00:00','Z');raw=json.dumps(stored_data(row['kind'],row['data']),ensure_ascii=False,separators=(',',':'))
                    await pool.execute('INSERT INTO items(id,kind,slug,version,data,deleted,created_at,updated_at) VALUES($1,$2,$3,1,$4,FALSE,$5,$5)',row['id'],row['kind'],row['slug'],raw,at)
                    await pool.execute('INSERT INTO live(item_id,kind,slug,version,data,published_at) VALUES($1,$2,$3,1,$4,$5)',row['id'],row['kind'],row['slug'],raw,at)
                await pool.execute("INSERT INTO site_fields(version,key,value,approved) VALUES(1,'private','true',1)")
                await pool.execute('INSERT INTO private_approvals(version) VALUES(1)')
                await pool.execute('INSERT INTO site_embed_sources(version,sources,approved) VALUES(1,$1,1)',json.dumps(rows[0]['data'].get('embed_sources',[])))
                token='prk_'+'A'*32
                await pool.execute("INSERT INTO agent_read_keys(id,name,key_hash,created_at,expires_at,owner_epoch) SELECT 'read_parity','Reader',$1,'2026-10-10','2099-01-01',owner_epoch FROM auth_state WHERE id=1",hashlib.sha256(token.encode()).hexdigest())
                v=await site.live_view(pool);paths=['/']
                for stream in v.site['streams']:
                    paths.append('/'+(stream.get('path') or stream['id'])+'/');paths.extend(x['page'] for x in v.entries if x['stream']==stream['id'] and not x.get('external_url'))
                if v.site.get('archive',{}).get('enabled'):paths.append('/archive/')
                cx=routes.Context(pool,'',None);out=[]
                for p in list(dict.fromkeys(paths))+['/llms.txt']:
                    copy=p if p=='/llms.txt' else p+'index.md';tag=''
                    for path,method,extra in [(p,'GET',{}),(copy,'GET',{}),(copy,'HEAD',{}),(p,'GET',{'Accept':'text/markdown'}),(copy,'GET',{'If-None-Match':'@tag'})]:
                        headers={'Authorization':'Bearer '+token,**extra}
                        if headers.get('If-None-Match')=='@tag':headers['If-None-Match']=tag
                        raw_path,_,query=path.partition('?')
                        req=Request({'type':'http','method':method,'scheme':'https','server':('example.invalid',443),'path':raw_path,'raw_path':raw_path.encode(),'query_string':query.encode(),'headers':[(k.lower().encode(),v.encode()) for k,v in headers.items()]+[(b'host',b'example.invalid')]})
                        r=await routes.handle(req,cx)
                        if path==copy and method=='GET' and not extra.get('If-None-Match'):tag=r.headers.get('etag','')
                        out.append({'path':path,'method':method,'extra':extra,'status':r.status_code,'headers':{k:r.headers.get(k) for k in FIELDS},'body':r.body.decode()})
                assert await pool.fetchval('SELECT count(*) FROM public_artifacts')==0
                (Path(output)/(look+'.json')).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    finally:
        if pool:await pool.close()
        await admin.execute(f'DROP DATABASE "{name}"');await admin.close()
if __name__=='__main__':asyncio.run(main(sys.argv[1],sys.argv[2:]))
