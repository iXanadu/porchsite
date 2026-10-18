"""Exact, narrowly allowed witness migration definitions; not application SQL."""
TABLES = ('live', 'items', 'site_fields', 'site_embed_sources',
          'site_stream_settings', 'private_approvals', 'training_approvals',
          'themes', 'share_cards', 'media')
CF_TABLE = """CREATE TABLE IF NOT EXISTS content_revision (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 n INTEGER NOT NULL CHECK (typeof(n) = 'integer' AND n >= 0)
)"""
PG_TABLE = """CREATE TABLE IF NOT EXISTS content_revision (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 n BIGINT NOT NULL CHECK (n >= 0)
)"""
CF_SEED = 'INSERT OR IGNORE INTO content_revision (id,n) VALUES (1,0)'
PG_SEED = 'INSERT INTO content_revision (id,n) VALUES (1,0) ON CONFLICT (id) DO NOTHING'
PG_FUNCTION = """CREATE FUNCTION advance_content_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 UPDATE content_revision SET n = n + 1
 WHERE id = 1 AND n >= 0 AND n < 9223372036854775807;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Unavailable content revision';
 END IF;
 RETURN NULL;
END;
$$"""


def cf_trigger(table, event, suffix):
    return f"""CREATE TRIGGER IF NOT EXISTS content_revision__{table}__{suffix}
AFTER {event} ON {table} FOR EACH ROW BEGIN
 UPDATE content_revision SET n = n + 1
 WHERE id = 1 AND typeof(n) = 'integer' AND n >= 0 AND n < 9223372036854775807;
 SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'Unavailable content revision') END;
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
