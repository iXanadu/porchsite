-- Existing daily visitor identities only; no new identifying data.
CREATE INDEX pageviews_day_visitor ON pageviews (day, visitor);
CREATE TABLE analytics_maintenance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completed_day TEXT NOT NULL
);
INSERT INTO analytics_maintenance (id, completed_day) VALUES (1, '');
