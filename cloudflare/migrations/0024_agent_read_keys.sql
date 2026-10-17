-- Published-only credentials are deliberately unknown to old writer lookups.
CREATE TABLE agent_read_keys (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 key_hash TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 last_used_at TEXT,
 revoked_at TEXT,
 owner_epoch INTEGER NOT NULL
);
CREATE TABLE agent_read_key_events (
 id TEXT PRIMARY KEY,
 created_at TEXT NOT NULL,
 actor TEXT NOT NULL,
 key_id TEXT NOT NULL,
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('created','revoked'))
);
