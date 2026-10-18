"""Owner-authorized operator only. Creates and deletes ONE empty test D1.
No Worker/KV/account setting writes. No production or existing database use.
Default is a pure dry run. Tokens/identifiers never enter the evidence.
"""
from pathlib import Path
import argparse,json,os,re,secrets,sys,time,hashlib,urllib.request,urllib.error
from concurrent.futures import ThreadPoolExecutor
R=Path(__file__).resolve().parents[1];O=Path.cwd()/'hosted-probe-out';O.mkdir(exist_ok=True)
sys.path.insert(0,str(R/'scripts'));from sql_statements import statements
FILES=sorted((R/'cloudflare/migrations').glob('*.sql'));W=FILES[-1];PARTS=statements(W.read_text());assert W.name=='0027_content_revision.sql' and len(PARTS)==32
NAMES=[sql.split()[2]for sql in PARTS if sql.upper().startswith('CREATE TRIGGER')];assert len(NAMES)==30
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--run',action='store_true');parser.add_argument('--name-prefix',default='porchsite-witness-probe');args=parser.parse_args()
assert re.fullmatch(r'porchsite-witness-probe(?:-[a-z0-9-]{1,20})?',args.name_prefix)
if not args.run:
 print('DRY RUN: no account access. 27 actual migration files; witness alone has32 statements, so under30 SQL statements is impossible. Expected PASS lines: fresh, prerequisite, first-fault-rollback, first-install, idempotent-skip, reentry-fault-rollback/concurrent-SQL, counter-increment, missing-row-repair, deleted.');raise SystemExit(0)
assert os.environ.get('PERF9A_HOSTED_OWNER_APPROVED')=='1','Owner authorization required before --run'
token=os.environ['CLOUDFLARE_API_TOKEN'];account=os.environ['CLOUDFLARE_ACCOUNT_ID'];assert re.fullmatch('[0-9a-f]{32}',account)
base='https://api.cloudflare.com/client/v4/accounts/'+account;db_id=None
class APIError(Exception):
 def __init__(self,status,codes):self.status=status;self.codes=codes;super().__init__('API refused; status='+str(status)+' codes='+str(codes))
def api(method,path,body=None):
 req=urllib.request.Request(base+path,data=json.dumps(body).encode()if body is not None else None,method=method,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=30)as response:data=json.load(response);status=response.status
 except urllib.error.HTTPError as response:data=json.load(response);status=response.code
 if not data.get('success'):raise APIError(status,[e.get('code')for e in data.get('errors',[])])
 return data.get('result')
def q(sql):
 # Same body shape and top-level success contract as board/installer.ts q().
 values=api('POST','/d1/database/'+db_id+'/query',{'sql':sql});return values[0].get('results',[])if values else []
def migration(sql,name):return q(sql+"\n;INSERT INTO _sitekeeper_migrations VALUES ('"+name.replace("'",'')+"', datetime('now'));")
CATALOG="SELECT type,name,sql FROM sqlite_master WHERE name='content_revision' OR (type='trigger' AND name GLOB 'content_revision__*') ORDER BY name"
def catalog():return q(CATALOG)
def pair():
 rows=q('SELECT epoch,typeof(epoch) AS epoch_storage,CAST(n AS TEXT) AS n,typeof(n) AS storage FROM content_revision WHERE id=1');assert len(rows)==1;v=rows[0]
 assert v['epoch_storage']=='text' and re.fullmatch('[0-9a-f]{32}',v['epoch']) and v['storage']=='integer' and re.fullmatch('0|[1-9][0-9]{0,18}',v['n']) and int(v['n'])<=9223372036854775807;return v
result={'pass':False,'scope':'Actual hosted REST whole-migration-plus-ledger transaction probe; synthetic legacy SQL control, NOT old Worker HTTP or actual board no-publish proof','migration_sha256':hashlib.sha256(W.read_bytes()).hexdigest(),'steps':[]}
def passed(name,**fields):
 result['steps'].append({'name':name,'pass':True,**fields});(O/'hosted-results.json').write_text(json.dumps(result,indent=2));print('PASS',name,flush=True)
name=args.name_prefix+'-'+secrets.token_hex(5)
try:
 made=api('POST','/d1/database',{'name':name});db_id=made['uuid'];assert db_id
 assert q("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")[0]['n']==0
 passed('fresh')
 q('CREATE TABLE IF NOT EXISTS _sitekeeper_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
 for file in FILES[:-1]:migration(file.read_text(),file.name)
 passed('prerequisites',files=26)
 bad=';\n'.join(PARTS[:12]+['SELECT * FROM deliberately_missing_witness_probe']+PARTS[12:])+';'
 try:migration(bad,W.name)
 except APIError:pass
 else:raise AssertionError('First fault was not rejected')
 assert catalog()==[] and not q("SELECT name FROM _sitekeeper_migrations WHERE name='0027_content_revision.sql'")
 passed('first-fault-rollback')
 migration(W.read_text(),W.name);exact=catalog();assert sum(x['type']=='trigger'for x in exact)==30;first=pair();passed('first-install')
 have={x['name']for x in q('SELECT name FROM _sitekeeper_migrations')};applied=0
 for file in FILES:
  if file.name not in have:migration(file.read_text(),file.name);applied+=1
 assert applied==0 and pair()==first and len(have)==27;passed('idempotent-skip')
 prefix='\n'.join('DROP TRIGGER '+n+';'for n in NAMES)+'\nDROP TABLE content_revision;\n'
 def failed_reentry():
  try:migration(prefix+bad,'probe_reentry.sql')
  except APIError:return True
  return False
 def observe():
  snapshots=[]
  for _ in range(6):
   value=catalog();assert value==exact,'Incomplete/changed inventory visible';snapshots.append(len(value));time.sleep(.02)
  return snapshots
 with ThreadPoolExecutor(max_workers=3)as pool:
  install=pool.submit(failed_reentry);writer=pool.submit(q,'INSERT INTO private_approvals(version) VALUES(812345)');observed=pool.submit(observe)
  assert install.result();writer.result();snapshots=observed.result()
 after=pair();assert catalog()==exact and after['epoch']==first['epoch'] and int(after['n'])==int(first['n'])+1
 assert not q("SELECT name FROM _sitekeeper_migrations WHERE name='probe_reentry.sql'")
 passed('reentry-fault-rollback-and-concurrent-SQL',snapshots=snapshots)
 q('INSERT INTO private_approvals(version) VALUES(812346)');bumped=pair();assert bumped['epoch']==after['epoch'] and int(bumped['n'])==int(after['n'])+1;passed('counter-increment')
 q('DELETE FROM content_revision WHERE id=1');q('INSERT INTO private_approvals(version) VALUES(812347)');repaired=pair();assert repaired['epoch']!=bumped['epoch'] and repaired['n']=='1';passed('missing-row-repair')
 result['pass']=True
finally:
 if db_id:
  api('DELETE','/d1/database/'+db_id);remaining=api('GET','/d1/database?name='+name);assert all(x.get('uuid')!=db_id for x in remaining);passed('deleted')
 (O/'hosted-results.json').write_text(json.dumps(result,indent=2))
