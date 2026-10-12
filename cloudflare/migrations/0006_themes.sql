-- Themes the assistant installed from the Sitekeeper catalog (the whole
-- package as JSON, checked against the catalog's sha256 when installed).
CREATE TABLE themes (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  package TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  installed_by TEXT NOT NULL
);
