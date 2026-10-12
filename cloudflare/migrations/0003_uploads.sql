-- One-time links an assistant sends its person so they can add a photo from
-- their phone. The link's secret is stored only as a hash; `id` is what the
-- assistant uses to ask how it went.
CREATE TABLE uploads (
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
