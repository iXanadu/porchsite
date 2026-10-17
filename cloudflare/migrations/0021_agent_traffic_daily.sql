-- Aggregate request counts only; no per-request data or legacy analytics changes.
CREATE TABLE agent_traffic_daily (
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('search', 'training', 'user', 'other')),
  requests INTEGER NOT NULL DEFAULT 0 CHECK (typeof(requests) = 'integer' AND requests >= 0),
  PRIMARY KEY (day, kind)
);
