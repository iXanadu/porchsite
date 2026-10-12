-- The server edition's storage: the Cloudflare edition's migrations
-- (cloudflare/migrations/0001..0009) as one PostgreSQL schema, same tables
-- and meaning. Applied at every startup; every statement is idempotent.
-- Later changes go in server/server/app/db.py MIGRATIONS, never here.
--
-- Times are ISO 8601 strings (2026-10-10T09:00:00.000Z), as the Cloudflare
-- edition writes them, so the two editions compare and order them the same.
-- Item data is the JSON text exactly as written (key order kept).

-- Current state of every item. Drafts and edits live here; the public site
-- reads only `live`. version goes up by one on every change.
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  slug TEXT CONSTRAINT items_slug_key UNIQUE,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every version of every item, never updated or deleted (SPEC S5).
CREATE TABLE IF NOT EXISTS revisions (
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  data TEXT NOT NULL,
  deleted BOOLEAN NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, version)
);

-- Replayed creates return the first answer (SPEC S4).
CREATE TABLE IF NOT EXISTS idempotency (
  actor TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, key)
);

-- What the public sees: one row per published item, at the approved version.
CREATE TABLE IF NOT EXISTS live (
  item_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  slug TEXT,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  published_at TEXT NOT NULL
);

-- A request for the owner's yes: named items at named versions (SPEC S2).
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  items TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status_created ON approvals (status, created_at);

CREATE TABLE IF NOT EXISTS publishes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor TEXT NOT NULL,
  approval_id TEXT,
  items TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The owner (one per site), their passkeys, sessions and pending challenges.
CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  user_handle TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Images, stored in the site's own database (SPEC S7: no hotlinks). One row
-- per distinct image, named by a hash of its bytes. Width and height are read
-- from the image header when stored (0 when unknown), so themes can reserve
-- the space. The Cloudflare edition splits the bytes into chunks (a D1 row
-- holds at most 2 MB); a bytea column needs no chunks.
CREATE TABLE IF NOT EXISTS media (
  name TEXT PRIMARY KEY,        -- <hash>.<ext>, served at /media/<name>
  type TEXT NOT NULL,           -- image/jpeg | image/png | image/webp
  size INTEGER NOT NULL,
  data BYTEA NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0
);

-- One-time links an assistant sends its person so they can add a photo from
-- their phone. The link's secret is stored only as a hash; `id` is what the
-- assistant uses to ask how it went.
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  media TEXT,                   -- /media/<name> once the photo arrives
  alt TEXT,
  used_at TEXT
);

-- One-time links a signed-in owner makes to add a passkey on another device
-- or another address of the same site (a passkey only works where it was made).
CREATE TABLE IF NOT EXISTS passkey_links (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Themes the assistant installed from the catalog (the whole package as JSON,
-- checked against the catalog's sha256 when installed), and looks made on this
-- site by the assistant (source 'private': only this site has them).
CREATE TABLE IF NOT EXISTS themes (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  package TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  installed_by TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'catalog'
);

-- Theme requests this site filed with the community queue, and the one-time
-- proofs it answers so the queue knows a request came from here.
CREATE TABLE IF NOT EXISTS request_proofs (
  nonce TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS theme_requests (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  filed_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Looks this site shared with the catalog's review queue.
CREATE TABLE IF NOT EXISTS theme_submissions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Which changes after this schema have been applied (db.py MIGRATIONS).
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
