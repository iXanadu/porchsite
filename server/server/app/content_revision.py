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
