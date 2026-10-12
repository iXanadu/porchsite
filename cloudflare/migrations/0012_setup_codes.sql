-- One-time setup codes issued after deploy (SPEC §5), stored only as
-- hashes, each with an expiry. Issuing one replaces any earlier one;
-- claiming the site deletes them all. The SETUP_CODE secret still works.
CREATE TABLE setup_codes (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
