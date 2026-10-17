-- Opaque validator identities, never session grants or stored private content.
CREATE TABLE agent_read_session_ids (
 kind TEXT NOT NULL CHECK(kind IN ('owner','reader')),
 session_hash TEXT NOT NULL,
 id TEXT NOT NULL UNIQUE,
 PRIMARY KEY(kind,session_hash)
);
