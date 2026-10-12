-- Why a publish happened, in the owner's words (a whole-site revert, the
-- owner's own writing); empty for an approval.
ALTER TABLE publishes ADD COLUMN note TEXT NOT NULL DEFAULT '';

-- Visitor analytics (SPEC §8). One random salt per day, deleted once the day
-- is over; a visitor is a hash of that salt with the address and browser, so
-- the address itself is never stored and yesterday's visitors can't be
-- recomputed.
CREATE TABLE analytics_salts (
  day TEXT PRIMARY KEY,         -- YYYY-MM-DD on the site's clock
  salt TEXT NOT NULL
);

-- One row per page view; heartbeats add engaged time and scroll depth.
-- Kept 90 days.
CREATE TABLE pageviews (
  id TEXT PRIMARY KEY,          -- random, made by the reader's browser
  day TEXT NOT NULL,
  visitor TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_id TEXT NOT NULL DEFAULT '',
  ref_bucket TEXT NOT NULL,
  ref_domain TEXT NOT NULL DEFAULT '',
  prev_path TEXT NOT NULL DEFAULT '',
  src TEXT NOT NULL DEFAULT '',
  post TEXT NOT NULL DEFAULT '',
  test INTEGER NOT NULL DEFAULT 0,
  engaged_ms INTEGER NOT NULL DEFAULT 0,
  max_scroll INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pageviews_day ON pageviews (day);
