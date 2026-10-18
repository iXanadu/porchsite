"""SP-S4 paired rendered-target, document-order and traversal-boundary proofs."""
import json
from pathlib import Path
import pytest
from server.app import check, builtin
from server.app.content import validate
from server.spec import theme
from server.spec.site import view
CASES=json.loads((Path(__file__).resolve().parents[3]/'spec/fixtures/site-check-targets.json').read_text())
DATA=validate('site',{'title':'Targets','theme':'personal-homepage','sections':['entries'],'streams':[{'id':'journal','title':'Journal','path':'reports'}],'archive':{'enabled':True,'title':'All pages'}})
def entry(id):
 return {'id':id,'kind':'entry','slug':id,'data':validate('entry',{'title':id,'date':'2026-10-10','body':'Full body','summary':'Summary only',**({'external_url':'https://external.example/?a=1&b=2'} if id=='external' else {})})}
def look(home):
 return {'manifest':{},'partials':{},'static':{},'pages':{'home':home,'archive':'<a href="/reports/a/">A</a>','entry':'<a href="/reports/b/">B</a>'}}
@pytest.mark.parametrize('case',CASES,ids=lambda c:c['name'])
def test_site_check_target_cases(case):
 r=check.check_site_deep(view(DATA,[entry(x) for x in case['entries']]),set(),look(case['home']))
 assert [x['id'] for x in r['unreachable']]==case['unreachable']
 assert r['ok']==(not case['unreachable']) and 'crawl' not in r
@pytest.mark.parametrize('count',[200,500])
def test_site_check_target_listing(count,monkeypatch):
 calls={'home':0,'archive':0,'entry':0}
 def wrap(name,fn):
  def f(*a,**k):calls[name]+=1;return fn(*a,**k)
  return f
 monkeypatch.setattr(theme,'home_view',wrap('home',theme.home_view))
 monkeypatch.setattr(theme,'entry_view',wrap('entry',theme.entry_view))
 monkeypatch.setattr(builtin,'all_archive_page',wrap('archive',builtin.all_archive_page))
 r=check.check_site_deep(view(DATA,[entry('entry-'+str(i)) for i in range(count)]),set(),look('<a href="/archive/">All pages</a>'))
 assert r=={'ok':True,'broken':[],'empty_sections':[],'unreachable':[]}
 assert calls=={'home':1,'archive':1,'entry':0}
@pytest.mark.parametrize('before',[9999,10000])
def test_site_check_target_caps_links(before):
 home='<a href="mailto:owner@example.com">Mail</a>'*before+'<a href="/reports/a/">A</a>'+'<a href="/missing/">Leftover</a>'*10001
 r=check.check_site_deep(view(DATA,[entry('a')]),set(),look(home))
 if before==9999:assert r['ok'] and 'crawl' not in r
 else:assert not r['ok'] and r['unreachable']==[] and r['crawl']=={'limit':'links','pages':1,'links':10000,'max_pages':200,'max_links':10000}
@pytest.mark.parametrize('before',[198,199])
def test_site_check_target_caps_pages(before):
 home=''.join(f'<a href="/missing-{i}/">Missing</a>' for i in range(before))+'<a href="/reports/">Listing</a>'
 r=check.check_site_deep(view(DATA,[entry('a')]),set(),look(home))
 if before==198:assert r['ok'] and 'crawl' not in r
 else:assert not r['ok'] and r['unreachable']==[] and r['crawl']['limit']=='pages' and r['crawl']['pages']==200

def test_site_check_target_quick(monkeypatch):
 def fail(*a,**k):raise AssertionError('empty target set/default quick must not render')
 monkeypatch.setattr(theme,'home_view',fail)
 v=view({**DATA,'cta_link':'/missing/'},[])
 quick=check.check_site(v,set());deep=check.check_site_deep(v,set(),look('<a href="/reports/a/">A</a>'))
 assert deep=={**quick,'unreachable':[]} and not deep['ok']

def test_site_check_target_redirect_cycle():
 d=validate('site',{**DATA,'streams':[{'id':'journal','title':'Journal','path':'e'}]})
 r=check.check_site_deep(view(d,[entry('a')]),set(),look('<a href="/journal/a">Moved</a><a href="/e/a/">Cycle</a>'))
 assert not r['ok'] and 'crawl' not in r and [x['id'] for x in r['unreachable']]==['a']
