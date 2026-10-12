-- Theme requests this site filed with the Sitekeeper community queue, and
-- the one-time proofs it answers so the queue knows a request came from here.
CREATE TABLE request_proofs (
  nonce TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE theme_requests (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  filed_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
