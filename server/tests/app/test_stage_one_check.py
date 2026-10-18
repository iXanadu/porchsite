"""A deliberately incomplete look: port of stage-one-check.test.ts."""
import json

from server.app import content, oauth, themes

from .web import Mcp, publish


async def test_reports_the_published_entry_a_rendered_look_drops_excluding_drafts(db, http):
    who = "assistant:test"
    s = await content.create_item(db, who, "site", {"title": "Test", "theme": "dropped-entry", "sections": ["entries"]}, None)
    visible = await content.create_item(db, who, "entry", {"title": "Visible", "date": "2026-10-10", "slug": "visible", "status": "ready"}, None)
    hidden = await content.create_item(db, who, "entry", {"title": "Hidden", "date": "2026-10-09", "slug": "hidden", "status": "ready"}, None)
    draft = await content.create_item(db, who, "entry", {"title": "Draft", "date": "2026-10-08", "status": "draft"}, None)
    base = themes.built_in()["product-page"]
    look = {**base, "manifest": {**base["manifest"], "name": "dropped-entry"}, "pages": {**base["pages"], "home": '<html><body><a href="/journal/visible/">{{site.title}}</a></body></html>', "entry": '<html><body><a href="/">{{site.title}}</a></body></html>'}}
    # Bypass the quality gate only to install the intentionally broken fixture.
    await db.execute("INSERT INTO themes (name, version, package, sha256, installed_at, installed_by, source) VALUES ($1, $2, $3, $4, $5, $6, 'private')", "dropped-entry", "1.0.0", json.dumps(look), "fixture", "2026-10-15", who)
    await publish(db, [s["id"], visible["id"], hidden["id"]])
    home = (await http.get("/")).text
    assert 'href="/journal/visible/"' in home
    assert "/journal/hidden/" not in home
    visible_page = (await http.get("/journal/visible/")).text
    assert 'href="/"' in visible_page
    assert 'href="/journal/"' not in visible_page
    a = Mcp(http, await oauth.mint(db, "Test", "https://site.example"))
    err, quick, _ = await a.call("site_check")
    assert not err
    assert quick == {"ok": True, "broken": [], "empty_sections": []}
    err, result, _ = await a.call("site_check", deep=True)
    assert not err
    assert result["ok"] is False
    assert [x["id"] for x in result["unreachable"]] == [hidden["id"]]
    assert isinstance(result["unreachable"][0]["why"], str)
    assert result["unreachable"][0]["why"]


async def test_site_check_target_graph(db,http):
    from server.app import approvals, read_keys
    from .test_read_keys import rpc
    who='assistant:test'
    s=await content.create_item(db,who,'site',{'title':'Graph','theme':'target-graph','sections':['entries'],'archive':{'enabled':True,'title':'All pages'}},None)
    a=await content.create_item(db,who,'entry',{'title':'A','slug':'a','date':'2026-10-10','body':'Old approved A','status':'ready'},None)
    c=await content.create_item(db,who,'entry',{'title':'C','slug':'c','date':'2026-10-10','body':'Approved C','status':'ready'},None)
    base=themes.built_in()['product-page']
    look={**base,'manifest':{**base['manifest'],'name':'target-graph'},'pages':{**base['pages'],'home':'<a href="/journal/b/">Proposed B</a>','entry':'Entry'}}
    await db.execute("INSERT INTO themes(name,version,package,sha256,installed_at,installed_by,source) VALUES($1,$2,$3,$4,$5,$6,'private')",'target-graph','1.0.0',json.dumps(look),'fixture','2026-10-18',who)
    await approvals.publish_now(db,[{'id':x['id'],'version':x['version']} for x in [s,a,c]],'','https://site.example')
    await content.update_item(db,who,a['id'],a['version'],{'body':'Proposed draft A','status':'draft'})
    await content.remove_item(db,who,c['id'],c['version'])
    b=await content.create_item(db,who,'entry',{'title':'B','slug':'b','date':'2026-10-10','body':'Proposed ready B','status':'ready'},None)
    await db.execute("INSERT INTO public_artifacts(key,generation,body,metadata,valid_until,size) VALUES('graph-fixture','fixture','<a href=\"/journal/a/\">A</a><a href=\"/journal/c/\">C</a>','{}',9999999999999,1)")
    writer=Mcp(http,await oauth.mint(db,'Writer','https://site.example'))
    err,proposed,_=await writer.call('site_check',deep=True)
    assert not err and proposed=={'ok':True,'broken':[],'empty_sections':[],'unreachable':[]}
    reader=await read_keys.create(db,'Reader')
    response,out=await rpc(http,reader['token'],'tools/call',{'name':'site_check','arguments':{'deep':True}},True)
    assert response.status_code==200 and not out['result'].get('isError')
    approved=json.loads(out['result']['content'][0]['text'])
    assert not approved['ok'] and sorted(x['id'] for x in approved['unreachable'])==sorted([a['id'],c['id']])
    assert not any(x['id']==b['id'] for x in approved['unreachable'])
