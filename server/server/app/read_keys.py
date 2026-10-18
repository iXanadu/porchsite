from . import owner
"""Published-only credentials isolated from legacy drafting keys."""
import base64
import hashlib
import secrets
from datetime import UTC,datetime,timedelta
from .db import transaction
from .errors import ApiError
from .guard import check_guard
PREFIX,KEY_DAYS='prk_',90
ALLOWED={'site_state','site_check','page_get','pages_list','search'}
INSTRUCTIONS='Published pages can be read with site_state, site_check, page_get, pages_list and search. This connection cannot draft, read owner review or publish.'
def now():return datetime.now(UTC).isoformat(timespec='milliseconds').replace('+00:00','Z')
def restricted(props):return props.get('scope')=='published_read'
async def create(db,name,actor='owner',req=None):
    check_guard(name)
    token=PREFIX+base64.urlsafe_b64encode(secrets.token_bytes(24)).decode().rstrip('=')
    key_id='read_'+secrets.token_hex(12);at=now()
    expires=(datetime.now(UTC)+timedelta(days=KEY_DAYS)).isoformat(timespec='milliseconds').replace('+00:00','Z')
    async with transaction(db) as c:
        await c.fetchval('SELECT id FROM auth_state WHERE id=1 FOR UPDATE')
        if req is not None and not await owner.signed_in(c,req):
            raise ApiError(403,'not_verified','This sign-in stopped working. Start again.')
        await c.execute('INSERT INTO agent_read_keys(id,name,key_hash,created_at,expires_at,owner_epoch) SELECT $1,$2,$3,$4,$5,owner_epoch FROM auth_state WHERE id=1',key_id,name,hashlib.sha256(token.encode()).hexdigest(),at,expires)
        await c.execute("INSERT INTO agent_read_key_events(id,created_at,actor,key_id,name,kind) SELECT $1,$2,$3,id,name,'created' FROM agent_read_keys WHERE id=$4",'event_'+secrets.token_hex(12),at,actor,key_id)
    return {'id':key_id,'token':token,'expires_at':expires}
async def list(db):
    return [dict(r) for r in await db.fetch('SELECT id,name,created_at,expires_at,last_used_at FROM agent_read_keys WHERE revoked_at IS NULL AND expires_at>$1 AND owner_epoch=(SELECT owner_epoch FROM auth_state WHERE id=1) ORDER BY created_at DESC,id',now())]
async def events(db):
    return [dict(r) for r in await db.fetch('SELECT created_at,actor,key_id,name,kind FROM agent_read_key_events ORDER BY created_at DESC,id')]
async def revoke(db,key_id,actor='owner',req=None):
    async with transaction(db) as c:
        await c.fetchval('SELECT id FROM auth_state WHERE id=1 FOR UPDATE')
        if req is not None and not await owner.signed_in(c,req):
            raise ApiError(403,'not_verified','This sign-in stopped working. Start again.')
        row=await c.fetchrow('SELECT name FROM agent_read_keys WHERE id=$1 AND revoked_at IS NULL FOR UPDATE',key_id)
        if not row:return
        at=now()
        await c.execute('UPDATE agent_read_keys SET revoked_at=$1 WHERE id=$2',at,key_id)
        await c.execute("INSERT INTO agent_read_key_events(id,created_at,actor,key_id,name,kind) VALUES($1,$2,$3,$4,$5,'revoked')",'event_'+secrets.token_hex(12),at,actor,key_id,row['name'])
async def lookup(db,token):
    import re
    if not re.fullmatch(r'prk_[A-Za-z0-9_-]{32}',token):return None
    row=await db.fetchrow('SELECT id,name,owner_epoch FROM agent_read_keys WHERE key_hash=$1 AND revoked_at IS NULL AND expires_at>$2 AND owner_epoch=(SELECT owner_epoch FROM auth_state WHERE id=1)',hashlib.sha256(token.encode()).hexdigest(),now())
    return {'scope':'published_read','readKeyId':row['id'],'ownerEpoch':row['owner_epoch'],'client':row['name'],'clientId':'read:'+row['id']} if row else None
async def valid(db,props):
    return bool(await db.fetchval('SELECT id FROM agent_read_keys WHERE id=$1 AND owner_epoch=$2 AND owner_epoch=(SELECT owner_epoch FROM auth_state WHERE id=1) AND revoked_at IS NULL AND expires_at>$3',props.get('readKeyId'),props.get('ownerEpoch'),now()))
async def authorize(db,props,name=None):
    if restricted(props) and (not await valid(db,props) or name is not None and name not in ALLOWED):
        raise ApiError(403,'unauthorized','This connection can only read published pages.')
async def used(db,props):
    await authorize(db,props)
    row=await db.fetchval('UPDATE agent_read_keys SET last_used_at=$1 WHERE id=$2 AND revoked_at IS NULL AND owner_epoch=$3 AND owner_epoch=(SELECT owner_epoch FROM auth_state WHERE id=1) AND expires_at>$4 RETURNING id',now(),props['readKeyId'],props['ownerEpoch'],now())
    if not row:raise ApiError(403,'unauthorized','This connection can only read published pages.')
