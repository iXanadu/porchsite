-- One-time links a signed-in owner makes to add a passkey on another device
-- or another address of the same site (a passkey only works where it was made).
CREATE TABLE passkey_links (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
