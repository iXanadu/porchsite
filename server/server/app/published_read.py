"""Reader projections; staged versions and approval metadata are never loaded."""
import hashlib
from . import site,themes,check as checker
from .db import dumps
from .errors import ApiError
from .read_keys import INSTRUCTIONS
from server.spec.theme import streams
async def state(db,args,principal=None):
    if args.get('full') is True or args.get('ids') is not None:
        raise ApiError(403,'unauthorized','Only the published page listing is available.')
    v=await site.live_view(db,True)
    principal=principal or {}
    visible=['site',*[e['id'] for e in v.entries],*[e['id'] for e in v.cards],*[e['id'] for e in v.notes]]
    changed=max([v.approved_at.get(i,'') for i in visible],default='')
    installed=await db.fetchval('SELECT installed_at FROM themes WHERE name=$1',str(v.site['theme'])) or ''
    changed=max(changed,installed)
    paths=[{'path':'/','title':str(v.site['title']),'changed_at':changed}] if v.approved_at.get('site') else []
    if v.approved_at.get('site') and v.site.get('archive',{}).get('enabled'):
        paths.append({'path':'/archive/','title':str(v.site['archive']['title']),'changed_at':changed})
    for s in (streams(v.site) if v.approved_at.get('site') else []):paths.append({'path':s['archive_url'],'title':s['title'],'changed_at':changed})
    for e in v.entries:
        if not e.get('external_url'):paths.append({'path':e['page'],'title':str(e['title']),'changed_at':max(v.approved_at.get('site',''),v.approved_at.get(e['id'],''),installed)})
    paths.sort(key=lambda p:p['path'].encode())
    import base64
    generation=hashlib.sha256(dumps(paths).encode()).hexdigest()
    binding=hashlib.sha256(dumps([principal.get('readKeyId'),principal.get('ownerEpoch')]).encode()).hexdigest()
    cursor='ag1_'+base64.urlsafe_b64encode(dumps({'v':1,'after':paths[19]['path'],'generation':generation,'binding':binding}).encode()).decode().rstrip('=') if len(paths)>20 else None
    guide={'scope':'published_read','tools':['site_state','site_check','page_get','pages_list','search'],'description':INSTRUCTIONS}
    revision='published-read-'+hashlib.sha256(dumps(guide).encode()).hexdigest()
    included=(args.get('guide') or {}).get('known_revision')!=revision
    return {'scope':'published_read','site':{'title':str(v.site['title'])},'pages':paths[:20],'next_cursor':cursor,**({'read_guide':guide} if included else {}),**({'guide':{'revision':revision,'included':included}} if args.get('guide') is not None else {})}
async def check(db,args,origin):
    v=await site.live_view(db)
    text=dumps({'site':v.site,'entries':v.entries,'cards':v.cards,'notes':v.notes})
    names={r['name'] for r in await db.fetch('SELECT name FROM media') if '/media/'+r['name'] in text}
    return checker.check_site_deep(v,names,await themes.load(db,str(v.site['theme'])),origin) if args.get('deep') else checker.check_site(v,names)
