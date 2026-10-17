"""Dependency validators from the shared minimal published facts."""
import json
from pathlib import Path
from starlette.requests import Request
from server.app.public_read import decode,choice,tag
root=Path(__file__).resolve().parents[2]
data=json.loads((root/'spec/fixtures/public-dependencies.json').read_text())
f=decode(data['rows'])
rows=[]
for path in data['paths']:
    req=Request({'type':'http','method':'GET','scheme':'https','server':('example.com',443),'path':path,'raw_path':path.encode(),'query_string':b'','headers':[]})
    c=choice(req,f)
    rows.append(dict(path=path,tag=tag(f,req,c,data['release'],data['now']) if c else None))
print(json.dumps(rows,ensure_ascii=False,separators=(',',':')))
