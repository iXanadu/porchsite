-- Images, stored in the site's own database (SPEC S7: no hotlinks). One row
-- per distinct image, named by a hash of its bytes; the bytes are split into
-- chunks because a D1 row holds at most 2 MB.
CREATE TABLE media (
  name TEXT PRIMARY KEY,        -- <hash>.<ext>, served at /media/<name>
  type TEXT NOT NULL,           -- image/jpeg | image/png | image/webp
  size INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE media_chunks (
  name TEXT NOT NULL,
  n INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (name, n)
);
