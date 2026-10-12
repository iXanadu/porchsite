-- Visitor analytics past their 90 days (SPEC §8): before a day's page views
-- are deleted, its counts are kept here, one row per day. Test runs aside.
CREATE TABLE analytics_daily (
  day TEXT PRIMARY KEY,         -- YYYY-MM-DD on the site's clock
  visits INTEGER NOT NULL,
  views INTEGER NOT NULL,
  engaged_ms INTEGER NOT NULL
);
