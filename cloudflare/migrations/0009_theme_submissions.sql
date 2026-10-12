-- Looks this site shared with the Sitekeeper catalog's review queue.
CREATE TABLE theme_submissions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
