-- Device settings are separate from versioned content and legacy auth JSON.
CREATE TABLE alert_keys (id INTEGER PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL);
CREATE TABLE alert_subscriptions (
  id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE,
  credential_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  origin TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_used_at INTEGER, last_claim_at INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE alert_deliveries (
  request_id TEXT NOT NULL, subscription_id TEXT NOT NULL REFERENCES alert_subscriptions(id) ON DELETE CASCADE,
  claim TEXT NOT NULL UNIQUE, attempted INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, subscription_id)
);
CREATE INDEX alert_deliveries_age ON alert_deliveries(created_at,claim);
