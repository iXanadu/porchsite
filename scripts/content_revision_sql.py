"""Exact, narrowly allowed witness migration definitions; not application SQL."""
TABLES = ('live', 'items', 'site_fields', 'site_embed_sources',
          'site_stream_settings', 'private_approvals', 'training_approvals',
          'themes', 'share_cards', 'media')
CF_TABLE = """CREATE TABLE IF NOT EXISTS content_revision (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 epoch TEXT NOT NULL CHECK (typeof(epoch) = 'text' AND length(epoch) = 32 AND epoch NOT GLOB '*[^0-9a-f]*'),
 n INTEGER NOT NULL CHECK (typeof(n) = 'integer' AND n >= 0)
)"""
PG_TABLE = """CREATE TABLE IF NOT EXISTS content_revision (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 epoch UUID NOT NULL,
 n BIGINT NOT NULL CHECK (n >= 0)
)"""
CF_SEED = "INSERT OR IGNORE INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),0)"
PG_SEED = 'INSERT INTO content_revision (id,epoch,n) VALUES (1,gen_random_uuid(),0) ON CONFLICT (id) DO NOTHING'
CF_VALID = "typeof(content_revision.epoch) = 'text' AND length(content_revision.epoch) = 32 AND content_revision.epoch NOT GLOB '*[^0-9a-f]*' AND typeof(content_revision.n) = 'integer' AND content_revision.n >= 0 AND content_revision.n < 9223372036854775807"
PG_VALID = 'prior.epoch IS NOT NULL AND prior.n >= 0 AND prior.n < 9223372036854775807'
PG_FUNCTION = f"""CREATE FUNCTION advance_content_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO content_revision AS prior (id,epoch,n) VALUES (1,gen_random_uuid(),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN {PG_VALID} THEN prior.epoch ELSE excluded.epoch END,
 n = CASE WHEN {PG_VALID} THEN prior.n + 1 ELSE 1 END;
 RETURN NULL;
END;
$$"""


def cf_trigger(table, event, suffix):
    return f"""CREATE TRIGGER IF NOT EXISTS content_revision__{table}__{suffix}
AFTER {event} ON {table} FOR EACH ROW BEGIN
 INSERT INTO content_revision (id,epoch,n) VALUES (1,lower(hex(randomblob(16))),1)
 ON CONFLICT (id) DO UPDATE SET
 epoch = CASE WHEN {CF_VALID} THEN content_revision.epoch ELSE excluded.epoch END,
 n = CASE WHEN {CF_VALID} THEN content_revision.n + 1 ELSE 1 END;
END"""


def pg_trigger(table, truncate=False):
    event = 'TRUNCATE' if truncate else 'INSERT OR UPDATE OR DELETE'
    suffix, scope = ('truncate', 'STATEMENT') if truncate else ('row', 'ROW')
    return f'''CREATE TRIGGER content_revision__{table}__{suffix}
AFTER {event} ON {table} FOR EACH {scope}
EXECUTE FUNCTION advance_content_revision()'''


def migration(dialect):
    if dialect == 'cf':
        return [CF_TABLE, *(cf_trigger(t,e,s) for t in TABLES
                for e,s in [('INSERT','ai'),('UPDATE','au'),('DELETE','ad')]), CF_SEED]
    if dialect == 'pg':
        return [PG_TABLE, PG_FUNCTION, *(pg_trigger(t,tr) for t in TABLES
                for tr in (False, True)), PG_SEED]
    raise ValueError(dialect)
