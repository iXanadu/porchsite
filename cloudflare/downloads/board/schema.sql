-- Theme requests: filed privately by Sitekeeper sites, curated by an
-- assistant (grouped, spam dropped). Nothing here is ever shown publicly;
-- the public sees only the curator's summaries, published on a site.
CREATE TABLE IF NOT EXISTS board_requests (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  examples TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',    -- new | grouped | spam
  group_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_votes (
  request_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, origin)
);
CREATE TABLE IF NOT EXISTS board_groups (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open',  -- open | answered
  theme TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_requests_origin ON board_requests (origin, created_at);

-- Looks a site's assistant made and the person chose to share. Re-checked
-- here; a curator recommends or rejects; the owner decides what's published.
-- Credit columns (author_x, claim_code, credit_verified): 0002_credit.sql.
CREATE TABLE IF NOT EXISTS board_submissions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  note TEXT NOT NULL,
  package TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',     -- new | recommended | rejected | published
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_submissions_origin ON board_submissions (origin, created_at);
