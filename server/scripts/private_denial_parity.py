"""Private gate parity with a database incapable of content/existence lookup."""
import asyncio,json
from pathlib import Path
from starlette.requests import Request
from server.app.privacy import access
class GateOnly:
    async def fetchrow(self,sql,*args):
        assert 'site_fields' in sql or 'sessions' in sql,'Content lookup before denial'
        return {'value':'true'} if 'site_fields' in sql else None
async def main():
    fixture=json.loads((Path(__file__).resolve().parents[2]/'spec/fixtures/private-denial.json').read_text())
    fields=['cache-control','content-type','content-security-policy','x-robots-tag','x-content-type-options','location','etag','last-modified','link','vary'];out=[]
    for path in fixture['paths']:
        for accept in fixture['accept']:
            for auth in [None,*fixture['authorization']]:
                for method in ['GET','HEAD']:
                    headers=[(b'accept',accept.encode()),(b'if-none-match',b'*')]
                    if auth is not None:headers.append((b'authorization',auth.encode()))
                    req=Request({'type':'http','method':method,'scheme':'https','server':('example.com',443),'path':path,'query_string':b'','headers':headers})
                    _,_,r=await access(GateOnly(),req)
                    out.append({'path':path,'accept':accept,'auth':auth,'method':method,'status':r.status_code,'body':'' if method=='HEAD' else r.body.decode(),'headers':{k:r.headers.get(k) for k in fields}})
    print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
if __name__=='__main__':asyncio.run(main())
