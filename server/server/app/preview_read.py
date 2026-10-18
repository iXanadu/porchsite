"""Same-principal inspection only: no owner wrapper, stored graph or HTTP grant."""
import json
import re
import time
from datetime import UTC, datetime
from ada_url import URL
from server.spec.site import view as site_view
from server.spec import theme as views
from . import builtin, site, theme, themes, public_time
from .content import validate
from .stream_settings import checked_settings
from .agent_markdown import Tree, markdown_document
from .db import dumps
from .errors import ApiError
from .media import LOCAL, size as header_size
from server.spec.html import esc

NOTICE='Preview: not published.'
MAX_BODY=256*1024
MAX_ENVELOPE=320*1024
SNAPSHOT_SQL='''WITH a AS (SELECT id,items,status FROM approvals WHERE id=$1),
 m AS (SELECT value->>'id' id,(value->>'version')::integer version FROM a,jsonb_array_elements(a.items::jsonb)),
 chosen AS (SELECT r.data,r.version FROM revisions r JOIN m ON m.id=r.item_id AND m.version=r.version WHERE r.item_id='site' AND NOT r.deleted
 UNION ALL SELECT data,version FROM live WHERE item_id='site' AND NOT EXISTS(SELECT 1 FROM m WHERE id='site')),
 versions AS (SELECT version FROM chosen UNION SELECT version FROM live WHERE item_id='site'),
 parts0(category,ident,value) AS MATERIALIZED (
 SELECT 'approval',id,json_build_array(items,status)::text FROM a
 UNION ALL SELECT 'item',i.id,json_build_array(i.kind,i.slug,i.version,i.deleted,i.created_at)::text FROM items i JOIN m ON m.id=i.id
 UNION ALL SELECT 'revision',r.item_id,json_build_array(r.version,r.data,r.deleted)::text FROM revisions r JOIN m ON m.id=r.item_id AND m.version=r.version
), parts1(category,ident,value) AS MATERIALIZED (
 SELECT 'live',l.item_id,json_build_array(l.kind,l.slug,l.version,l.data,l.published_at,i.created_at)::text FROM live l LEFT JOIN items i ON i.id=l.item_id
 UNION ALL SELECT 'field',version::text||':'||key,json_build_array(version,key,value,approved)::text FROM site_fields WHERE version IN (SELECT version FROM versions)
 UNION ALL SELECT 'embed',version::text,json_build_array(version,sources,approved)::text FROM site_embed_sources WHERE version IN (SELECT version FROM versions)
), parts2(category,ident,value) AS MATERIALIZED (
 SELECT 'streams',version::text,json_build_array(version,settings,approved)::text FROM site_stream_settings WHERE version IN (SELECT version FROM versions)
 UNION ALL SELECT 'private',version::text,json_build_array(version)::text FROM private_approvals WHERE version IN (SELECT version FROM versions)
 UNION ALL SELECT 'training',version::text,json_build_array(version)::text FROM training_approvals WHERE version IN (SELECT version FROM versions)
), parts3(category,ident,value) AS MATERIALIZED (
 SELECT 'theme',name,json_build_array(version,sha256,package)::text FROM themes WHERE name=(SELECT CASE data::jsonb->>'theme' WHEN 'classic' THEN 'personal-homepage' WHEN 'broadsheet' THEN 'product-page' ELSE COALESCE(data::jsonb->>'theme','built-in') END FROM chosen)
 UNION ALL SELECT 'media',name,json_build_array(width,height)::text FROM media WHERE name=(SELECT substr(data::jsonb->>'hero',8) FROM chosen)
 UNION ALL SELECT 'header',name,json_build_array(encode(substring(data from 1 for 65536),'hex'))::text FROM media WHERE width=0 AND name=(SELECT substr(data::jsonb->>'hero',8) FROM chosen)
), parts4(category,ident,value) AS MATERIALIZED (
 SELECT 'share',item_id,json_build_array(version,name)::text FROM share_cards
), combined AS MATERIALIZED (SELECT * FROM parts0 UNION ALL SELECT * FROM parts1 UNION ALL SELECT * FROM parts2), facts AS (SELECT * FROM combined UNION ALL SELECT * FROM parts3 UNION ALL SELECT * FROM parts4) SELECT category,ident,value FROM facts ORDER BY category COLLATE "C",ident COLLATE "C"'''

def unavailable(): raise ApiError(409,'preview_unavailable','The proposed page cannot be inspected.')
def changed(): raise ApiError(409,'content_changed','The proposed page changed. Request a new preview.')
def invalid(): raise ApiError(422,'invalid','Invalid preview arguments.')

async def capture(db,id):
    return [[r['category'],r['ident'],json.loads(r['value'])] for r in await db.fetch(SNAPSHOT_SQL,id)]

def logical(data,version,live,rows):
    def at(kind):return next((r[2] for r in rows if r[0]==kind and r[2][0]==version),None)
    out={**data,'broker':'','private':False,'ai_training_disabled':False}
    for _,_,v in (r for r in rows if r[0]=='field' and r[2][0]==version):
        if live and not v[3]:continue
        if v[1]=='broker':out['broker']=json.loads(v[2])
        if v[1]=='private':out['private']=json.loads(v[2]) is True and (not live or bool(at('private')))
        if v[1]=='ai_training_disabled':out['ai_training_disabled']=json.loads(v[2]) is True and (not live or bool(at('training')))
    streams=at('streams')
    if streams and (not live or streams[2]):out.update(checked_settings(json.loads(streams[1])))
    embed=at('embed');out['embed_sources']=(json.loads(embed[1]) if not live or embed[2] else []) if embed else data.get('embed_sources',[])
    return validate('site',out)

def view(rows,at):
    approval=next((r for r in rows if r[0]=='approval'),None)
    if not approval:raise ApiError(404,'not_found','No pending approval or proposed page.')
    items=json.loads(approval[2][0])
    if approval[2][1]!='pending' or not isinstance(items,list) or not 1<=len(items)<=50 or len({i['id'] for i in items})!=len(items) or any(i['status']!='pending' for i in items):
        raise ApiError(409,'approval_changed','The approval changed. Request a current pending approval.')
    proposed={id:dict(id=id,kind=v[0],slug=v[1],version=v[2],data=json.loads(v[3]),published_at=v[4],created=v[5] or '') for kind,id,v in rows if kind=='live'}
    rendered_at=datetime.fromtimestamp(at/1000,UTC).isoformat(timespec='milliseconds').replace('+00:00','Z')
    for item in items:
        current=next((r[2] for r in rows if r[0]=='item' and r[1]==item['id']),None);rev=next((r[2] for r in rows if r[0]=='revision' and r[1]==item['id']),None)
        if not current or current[2]!=item['version']:raise ApiError(409,'approval_changed','The approval changed. Request a current pending approval.')
        if not rev or rev[0]!=item['version'] or current[3]!=rev[2]:unavailable()
        data=json.loads(rev[1])
        if current[0]=='entry' and data.get('status')=='draft' and not rev[2]:raise ApiError(409,'approval_changed','The approval changed. Request a current pending approval.')
        if rev[2]:proposed.pop(item['id'],None)
        else:proposed[item['id']]=dict(id=item['id'],kind=current[0],slug=current[1],version=rev[0],data=data,published_at=rendered_at,created=current[4])
    source=proposed.get('site')
    if not source:raise ApiError(404,'not_found','No pending approval or proposed page.')
    data=logical(source['data'],source['version'],not any(i['id']=='site' for i in items),rows)
    v=site_view(data,[r for r in proposed.values() if r['kind']!='site']);v.now=datetime.fromtimestamp(at/1000,UTC)
    visible={'site',*(e['id'] for e in v.entries),*(c['id'] for c in v.cards),*(n['id'] for n in v.notes)};visible_rows=[r for r in proposed.values() if r['id'] in visible]
    v.approved_at={r['id']:r['published_at'] for r in visible_rows}
    v.share_cards={id:'/media/'+c[1] for kind,id,c in rows if kind=='share' and proposed.get(id,{}).get('version')==c[0]}
    hero=LOCAL.search(str(data.get('hero')))
    if hero:
        size=next((r[2] for r in rows if r[0]=='media' and r[1]==hero[1]),None)
        if size and not size[0]:
            header=next((r[2][0] for r in rows if r[0]=='header' and r[1]==hero[1]),None)
            if header:size=header_size(bytes.fromhex(header))
        if not size or not size[0]:unavailable()
        v.hero_size=tuple(size)
    last=max((r['published_at'] for r in visible_rows),default='')
    if last:v.updated=site._updated(last,str(data.get('timezone') or 'UTC'))
    name=themes.ALIASES.get(str(data['theme']),str(data['theme']));installed=next((r for r in rows if r[0]=='theme' and r[1]==name),None)
    t=json.loads(installed[2][2]) if installed else themes.built_in().get(name)
    if not t and name!='built-in':unavailable()
    return v,t,[dict(id=i['id'],version=i['version']) for i in items]

ALLOW=set('main article section aside header footer nav div span p h1 h2 h3 h4 h5 h6 blockquote ul ol li dl dt dd strong em b i u s del ins code pre hr br table thead tbody tfoot tr th td caption figure figcaption details summary'.split())
DROP=set('head script style link base meta svg math template noscript form input button select option textarea object embed canvas'.split())
def inert(source):
    tree=Tree(source).root
    def find(n):return n if n['tag']=='body' else next((found for c in n['children'] if (found:=find(c))),None)
    root=find(tree) or tree
    def render(n,depth=0):
        if depth>128:unavailable()
        if not n['tag']:return esc(n['text'])
        attrs=n['attrs'];tag=n['tag']
        if tag in DROP or 'hidden' in attrs or attrs.get('aria-hidden')=='true' or re.search(r'(?:display\s*:\s*none|visibility\s*:\s*hidden)',attrs.get('style',''),re.I) or re.search(r'(?:^|\s)sk-owner-link(?:\s|$)',attrs.get('class','')):return ''
        if tag=='img':return '<span>'+esc('Image: '+attrs['alt'] if attrs.get('alt') else 'Image.')+'</span>'
        if tag in ('iframe','video','audio','picture'):return '<span>Embedded content.</span>'
        children=''.join(render(c,depth+1) for c in n['children'])
        if tag not in ALLOW:return children
        attributes=''
        for name in ('rowspan','colspan','scope','start'):
            if name not in attrs:continue
            value=attrs[name];normalized=None
            if name=='scope' and tag=='th' and value in ('row','col','rowgroup','colgroup'):normalized=value
            if ((name in ('rowspan','colspan') and tag in ('td','th')) or (name=='start' and tag=='ol')) and re.fullmatch(r'-?\d+',value,flags=re.ASCII):
                digits=value.lstrip('-').lstrip('0') or '0'
                if len(digits)<=10:
                    number=int(digits)*(-1 if value.startswith('-') else 1)
                    if (-2147483648<=number<=2147483647 if name=='start' else 1<=number<=1000):normalized=str(number)
            if normalized is not None:attributes+=' '+name+'="'+normalized+'"'
        tag='div' if tag=='nav' else tag
        return '<'+tag+attributes+'>'+('' if tag in ('br','hr') else children+'</'+tag+'>')
    return '<!doctype html><html><head><meta charset="utf-8"><title>Preview</title></head><body><main><p>'+NOTICE+'</p>'+render(root)+'</main></body></html>'

def arguments(args):
    if not isinstance(args,dict) or set(args)-{'approval_id','path','format'} or not isinstance(args.get('approval_id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,40}',args['approval_id']):invalid()
    path=args.get('path','/');format=args.get('format','markdown')
    if not isinstance(path,str) or any(0xd800<=ord(c)<=0xdfff for c in path) or len(path.encode())>2048 or not path.startswith('/') or '//' in path or re.search(r'[\\%?:#\x00-\x20\x7f]',path) or any(p in ('.','..') for p in path.split('/')) or not path.endswith('/') or format not in ('markdown','html'):invalid()
    if re.match(r'/(?:review|preview|setup|login|recover|invite|passkey|upload|mcp|api|media|static)(?:/|$)',path):invalid()
    return args['approval_id'],path,format

async def render_page(v,t,path,origin,release):
    policy=dict(sources=v.site.get('embed_sources'),origin=origin)
    if path=='/archive/' and v.site.get('archive',{}).get('enabled'):return builtin.all_archive_page(v,dict(sort='date',tag='',stream=''),origin,bool(t)).body.decode()
    if path=='/':return theme.render(t,'home',views.home_view(v,release,origin),policy,False) if t else builtin.home(v,origin).body.decode()
    entry=next((e for e in v.entries if e['page']==path and not e.get('external_url')),None)
    if entry:return theme.render(t,'entry',views.entry_view(v,entry,release,origin),policy,False) if t else builtin.entry_page(v,path,origin).body.decode()
    if t:
        match=re.fullmatch(r'/([a-z][a-z0-9-]{0,29})/(?:tags/([a-z0-9-]{1,30})/)?',path)
        av=views.archive_view(v,match[1],release,origin,match[2]) if match else None
        if av:return theme.render(t,'tag' if match[2] else 'archive',av,policy,False)
    raise ApiError(404,'not_found','No pending approval or proposed page.')

async def read(db,args,context):
    async def authorize():
        try:return await context['authorize']()
        except Exception:raise ApiError(403,'unauthorized','This tool requires a live drafting connection.') from None
    if not context:raise ApiError(403,'unauthorized','This tool requires a live drafting connection.')
    auth=await authorize()
    async def current():
        if await authorize()!=auth:raise ApiError(403,'unauthorized','This tool requires a live drafting connection.')
    id,path,format=arguments(args)
    try:
        url=URL(context['origin']);origin=url.origin
        if (url.protocol!='https:' and not (url.protocol=='http:' and url.hostname in ('localhost','127.0.0.1','[::1]'))) or url.username or url.password or url.pathname!='/' or url.search or url.hash or (context.get('siteOrigin') and origin!=URL(context['siteOrigin']).origin):unavailable()
    except Exception:unavailable()
    try:
        at=time.time()*1000;rows=await capture(db,id);v,t,items=view(rows,at)
        facts=dict(rows=rows,site=v.site,themed=bool(t),entries=[dict(id=e['id'],page=e['page'],streamId=e['stream'],tags=e.get('tags') or [],endpoint=(e.get('event') or {}).get('end') or (e.get('event') or {}).get('start')) for e in v.entries])
        clock=public_time.plan(facts,dict(base=path,kind='html'),at,False)
        if clock['kind']=='unknown':unavailable()
        await current();safe=inert(await render_page(v,t,path,origin,context.get('release','dev')));body=safe if format=='html' else markdown_document(safe,origin+path,False)['markdown']
        result=dict(approval_id=id,path=path,content_type='text/html; charset=utf-8' if format=='html' else 'text/markdown; charset=utf-8',notice=NOTICE,items=items,rendered_at=datetime.fromtimestamp(at/1000,UTC).isoformat(timespec='milliseconds').replace('+00:00','Z'),body=body)
        if len(body.encode())>MAX_BODY or len(dumps(result).encode())>MAX_ENVELOPE:raise ApiError(413,'preview_too_large','The proposed inspection copy is too large.')
        await current()
        try:latest=await capture(db,id)
        except Exception:changed()
        if latest!=rows or not public_time.valid(clock):changed()
        await current();return result
    except Exception as error:
        await current()
        if isinstance(error,ApiError):raise
        unavailable()
