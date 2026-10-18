"""Same render primitives/inert serializer as preview_read, without an HTTP grant."""
import asyncio,json
from datetime import UTC,datetime
from pathlib import Path
from server.app import themes
from server.app.preview_read import inert,render_page
from server.app.agent_markdown import markdown_document
from server.spec.sample import sample_view
async def main():
    root=Path(__file__).resolve().parents[2];origin='https://example.com';now=datetime(2026,10,15,15,30,tzinfo=UTC);out=[]
    for name,t in sorted(themes.built_in().items()):
        sample=json.loads((root/'themes'/name/'sample.json').read_text());v=sample_view(name,sample,now);v.site['archive']=dict(enabled=True,title='All entries')
        stream=v.site['streams'][0];paths=['/','/archive/','/'+(stream['path'] or stream['id'])+'/',*(e['page'] for e in [e for e in v.entries if not e.get('external_url')][:1])]
        for path in paths:
            html=inert(await render_page(v,t,path,origin,'test'));out.append(dict(name=name,path=path,html=html,markdown=markdown_document(html,origin+path,False)['markdown']))
    print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
asyncio.run(main())
