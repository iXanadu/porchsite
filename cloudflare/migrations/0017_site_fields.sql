-- Versioned logical site fields, never keys in legacy item JSON.
CREATE TABLE site_fields (
  version INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (version, key)
);
