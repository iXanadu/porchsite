CREATE TABLE auth_state (
  id INTEGER PRIMARY KEY,
  owner_epoch INTEGER NOT NULL DEFAULT 0,
  private_floor TEXT NOT NULL DEFAULT ''
);
INSERT INTO auth_state (id) VALUES (1);
CREATE TABLE owner_session_auth (
  token_hash TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  epoch INTEGER NOT NULL
);
CREATE TABLE auth_operations (id TEXT PRIMARY KEY);
CREATE TABLE readers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE reader_passkeys (
  id TEXT PRIMARY KEY,
  reader_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE reader_sessions (
  token_hash TEXT PRIMARY KEY,
  reader_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE reader_invites (
  token_hash TEXT PRIMARY KEY,
  reader_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE recovery_codes (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE private_approvals (
  version INTEGER PRIMARY KEY
);
