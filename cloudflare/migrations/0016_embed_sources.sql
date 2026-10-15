-- Site-version extension kept outside JSON read by earlier bundles.
CREATE TABLE site_embed_sources (
  version INTEGER PRIMARY KEY,
  sources TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0
);
