-- An entry's earlier addresses (SPEC §3): when its slug is changed, the old
-- one is kept here, and the old address answers 301 to the entry's page.
CREATE TABLE slug_history (
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,     -- the item's version that changed it
  slug TEXT NOT NULL,           -- the old slug
  new_slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, version)
);
CREATE INDEX slug_history_slug ON slug_history (slug);
