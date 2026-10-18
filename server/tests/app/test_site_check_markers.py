"""SP-S4-C1 actual-parser, lazy field and proof-provenance tests; paired Worker."""
import re
import pytest
from server.app import check
from server.app.content import validate
from server.spec import theme,embeds
from server.spec.site import view
from server.app.theme import render
DATA=validate('site',{'title':'Lazy check','theme':'personal-homepage','sections':['entries'],'archive':{'enabled':True,'title':'All pages'}})
ARCHIVE='<a href="/archive/">All pages</a>'
def entry(i,same=False,body=None):
 return {'id':f'entry-{i}','kind':'entry','slug':f'entry-{i}','data':validate('entry',{'title':f'Entry {i}','date':'2026-10-10','summary':f'Summary {i}','body':body if body is not None else 'Distinct full body '+('same' if same else str(i))})}
def look(home,policy=False):
 return {'manifest':{'heading_ids':policy,'body_h1_as_h2':policy},'partials':{},'static':{},'pages':{'home':home,'entry':'Entry'}}
def counter(monkeypatch):
 calls=[];original=embeds.markdown
 def wrapped(*a,**k):calls.append(a[0]);return original(*a,**k)
 monkeypatch.setattr(embeds,'markdown',wrapped)
 return calls
@pytest.mark.parametrize('count',[200,500])
def test_site_check_marker_unused(count,monkeypatch):
 calls=counter(monkeypatch)
 def no_date(*a,**k):raise AssertionError('unused dates must remain lazy')
 monkeypatch.setattr(theme,'_date',no_date)
 for same in [False,True]:
  for policy in [False,True]:
   calls.clear();r=check.check_site_deep(view(DATA,[entry(i,same) for i in range(count)]),set(),look('{{#sections}}{{#all}}{{title}} {{has_body}}{{/all}}{{/sections}}<porchsite-embed data-url="https%3A%2F%2Fvideo.example%2Fclip" data-title="Untrusted"></porchsite-embed>'+ARCHIVE,policy))
   assert r['ok'] and calls==[]
@pytest.mark.parametrize('count',[200,500])
def test_site_check_marker_latest(count,monkeypatch):
 calls=counter(monkeypatch)
 r=check.check_site_deep(view(DATA,[entry(i) for i in range(count)]),set(),look('{{#sections}}{{#latest}}{{{body_html}}}{{/latest}}{{/sections}}'+ARCHIVE,True))
 assert r['ok'] and len(calls)==1

def test_site_check_marker_inline_identity(monkeypatch):
 calls=counter(monkeypatch);outputs=[];original=check.render
 def capture(*a,**k):out=original(*a,**k);outputs.append(out);return out
 monkeypatch.setattr(check,'render',capture)
 t=look('{{#sections}}{{#all}}{{{body_html}}}{{{body_html}}}{{/all}}{{/sections}}',True);v=view(DATA,[entry(0,True),entry(1,True)])
 for _ in range(2):assert check.check_site_deep(v,set(),t)['ok']
 assert len(calls)==2
 tokens=[re.findall(r'<!--(porchsite-check-[a-f0-9-]+:)(\d+)-->',out) for out in outputs]
 assert [len(x) for x in tokens]==[4,4] and len({x[1] for x in tokens[0]})==2 and tokens[0][0][0]!=tokens[1][0][0]
 calls.clear();distinct=view(DATA,[entry(i) for i in range(6)])
 assert check.check_site_deep(distinct,set(),t)['ok'] and len(calls)==6
 assert len(check.check_site_deep(distinct,set(),look('{{#sections}}{{#latest}}{{{body_html}}}{{/latest}}{{/sections}}'))['unreachable'])==5

def test_site_check_marker_empty_inert_forged():
 v=view(DATA,[entry(0,body='')])
 for home in ['{{#sections}}{{#all}}{{summary}}{{{body_html}}}{{/all}}{{/sections}}','<template>{{#sections}}{{#all}}{{{body_html}}}{{/all}}{{/sections}}</template>','<!--porchsite-check-forged:0-->']:
  assert [x['id'] for x in check.check_site_deep(v,set(),look(home))['unreachable']]==['entry-0']
 assert not check.check_site_deep(view(DATA,[entry(0)]),set(),look('<template><template>{{#sections}}{{#all}}{{{body_html}}}{{/all}}{{/sections}}</template></template>'))['ok']

def test_site_check_marker_dates_public_identity(monkeypatch):
 calls=counter(monkeypatch);outputs=[];original=check.render
 def capture(*a,**k):out=original(*a,**k);outputs.append(out);return out
 monkeypatch.setattr(check,'render',capture)
 v=view(DATA,[entry(0)]);t=look('{{#sections}}{{#all}}{{date_short}} {{date_long}} {{has_body}}{{/all}}{{/sections}}'+ARCHIVE,True)
 assert check.check_site_deep(v,set(),t)['ok'] and calls==[]
 public=render(t,'home',theme.home_view(v,'check','https://example.invalid'))
 assert outputs[0]==public and 'porchsite-check-' not in public and 'Oct 10' in public

def test_site_check_marker_render_policy(monkeypatch):
 source='# Main\n\n## Detail\n\n| A | B |\n| --- | --- |\n| x | y |\n\n'+'\n\n'.join(f'!embed[Clip {i}](https://video.example/clip/{i})' for i in range(13))
 original=embeds.deferred_body({'body':source},source);clone=embeds.copy_deferred_body(original,{'body':source},'<!--porchsite-check-test:0-->');policy=embeds.heading_bodies(clone,True,True);calls=counter(monkeypatch)
 body=render(look('{{{body_html}}}',True),'home',policy,{'sources':['https://video.example'],'origin':'https://example.invalid'})
 assert len(calls)==1 and body.count('<iframe ')==12
 assert '<h2 id="main">Main</h2>' in body and '<table>' in body and '<!--porchsite-check-test:0-->' in body
 assert 'body_html' not in list(clone.keys())
 empty=embeds.copy_deferred_body(embeds.deferred_body({},''),{},'<!--porchsite-check-test:1-->')
 assert empty['body_html']==''
