-- Assistant keys (SPEC §4): for an assistant whose app can't add a connector
-- with sign-in. The owner makes one on /review/assistants and puts it in the
-- assistant's secret field; it's sent to /mcp as a bearer token. Only its
-- hash is kept. It drafts like any assistant; it expires, and can be revoked.
CREATE TABLE assistant_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
