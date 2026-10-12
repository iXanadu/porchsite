-- Current state of every item. Drafts and edits live here; the public site
-- reads only `live`. version goes up by one on every change.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  slug TEXT UNIQUE,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every version of every item, never updated or deleted (SPEC S5).
CREATE TABLE revisions (
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  data TEXT NOT NULL,
  deleted INTEGER NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, version)
);

-- Replayed creates return the first answer (SPEC S4).
CREATE TABLE idempotency (
  actor TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, key)
);

-- What the public sees: one row per published item, at the approved version.
CREATE TABLE live (
  item_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  slug TEXT,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  published_at TEXT NOT NULL
);

-- A request for the owner's yes: named items at named versions (SPEC S2).
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  items TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE publishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  approval_id TEXT,
  items TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The owner (one per site), their passkeys, sessions and pending challenges.
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  user_handle TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
