-- Exact-version stream settings, ignored by previous runtimes.
CREATE TABLE site_stream_settings (
  version INTEGER PRIMARY KEY,
  settings TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0
);
