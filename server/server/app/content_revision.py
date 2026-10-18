"""Request-local primary-database (epoch,counter), never a tag or grant."""
import json
import re

REVISION_SQL = "SELECT replace(epoch::text,'-','') AS epoch, pg_typeof(epoch)::text AS epoch_storage, n::text AS n, pg_typeof(n)::text AS storage FROM content_revision WHERE id = 1"
MAX = '9223372036854775807'


def canonical_counter(value):
    return (isinstance(value, str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,18})', value) is not None
            and (len(value) < len(MAX) or value <= MAX))


def canonical_epoch(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{32}', value) is not None


async def read_revision(db):
    try:
        rows = await db.fetch(REVISION_SQL)
        if len(rows) != 1:
            return None
        row = rows[0]
        if row['storage'] != 'bigint' or row['epoch_storage'] != 'uuid' or not canonical_epoch(row['epoch']) or not canonical_counter(row['n']):
            return None
        return json.dumps([row['epoch'], row['n']], separators=(',', ':'))
    except Exception:
        return None


WITNESS_CATEGORY='__content_revision_witness__'


def initial_sql():
    from .public_read import FACTS_SQL
    return f"""WITH dependency_facts AS ({FACTS_SQL})
SELECT category,ident,value FROM (SELECT category,ident,value FROM dependency_facts
UNION ALL SELECT '{WITNESS_CATEGORY}','epoch-counter-v1',json_build_array(replace(epoch::text,'-',''),pg_typeof(epoch)::text,n::text,pg_typeof(n)::text)::text FROM content_revision WHERE id=1) AS transport_rows
ORDER BY category COLLATE \"C\",ident COLLATE \"C\""""


def initial_snapshot(rows):
    from .public_read import decode
    state=[r for r in rows if r['category']==WITNESS_CATEGORY]
    dependencies=[r for r in rows if r['category']!=WITNESS_CATEGORY]
    pair=None
    try:
        value=json.loads(state[0]['value']) if len(state)==1 and state[0]['ident']=='epoch-counter-v1' else None
        if isinstance(value,list) and len(value)==4 and value[1]=='uuid' and value[3]=='bigint' and canonical_epoch(value[0]) and canonical_counter(value[2]):
            pair=json.dumps([value[0],value[2]],separators=(',',':'))
    except (ValueError,TypeError):
        pass
    raw=[[r['category'],r['ident'],r['value']] for r in dependencies]
    return {**decode(dependencies),'raw':raw},pair


async def initial_facts(db):
    from .public_read import facts
    try:
        rows=await db.fetch(initial_sql())
    except Exception as error:
        if getattr(error,'sqlstate',None)!='42P01' or not re.search(r'relation [\"\'](?:[^\"\']*\.)?content_revision[\"\'] does not exist',str(error)):
            raise
        return await facts(db),None
    return initial_snapshot(rows)
