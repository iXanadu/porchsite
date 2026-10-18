"""The database: one PostgreSQL schema (schema.sql), applied idempotently at
startup, plus a small list of later migrations. The Cloudflare edition keeps
the same tables in D1 (cloudflare/migrations).

Helpers shared by the services: `now()` writes times the way the Cloudflare
edition does (ISO 8601, milliseconds, Z), `dumps()` writes JSON the way
JSON.stringify does, and `transaction()` stands in for a D1 batch.
"""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg

Db = asyncpg.Pool | asyncpg.Connection

SCHEMA = Path(__file__).with_name("schema.sql")

# Changes after schema.sql, in order: (name, SQL). Each runs once, in a
# transaction, and is recorded in schema_migrations. Append only.
MIGRATIONS: list[tuple[str, str]] = [
    (
        # Assistants connected over OAuth (the Cloudflare edition keeps these in
        # KV through workers-oauth-provider): registered apps, the owner's
        # grants to them, and their codes and tokens, stored only as hashes.
        "0001_oauth",
        """
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  info TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  metadata TEXT NOT NULL,
  props TEXT NOT NULL,
  resource TEXT NOT NULL,
  redirect_uri TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  expires_at BIGINT
);
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
CREATE TABLE oauth_consents (
  handle_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  request TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
""",
    ),
    (
        # cloudflare/migrations/0010_analytics_history.sql: why a publish
        # happened (a whole-site revert, the owner's own writing), and visitor
        # analytics (SPEC §8): one random salt per day, page views kept 90 days.
        "0002_analytics_history",
        """
ALTER TABLE publishes ADD COLUMN note TEXT NOT NULL DEFAULT '';
CREATE TABLE analytics_salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);
CREATE TABLE pageviews (
  id TEXT PRIMARY KEY,
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
  test BOOLEAN NOT NULL DEFAULT FALSE,
  engaged_ms INTEGER NOT NULL DEFAULT 0,
  max_scroll INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pageviews_day ON pageviews (day);
""",
    ),
    (
        # cloudflare/migrations/0011_slug_history.sql: an entry's earlier
        # addresses; the old one answers 301 to the entry's page (SPEC §3).
        "0003_slug_history",
        """
CREATE TABLE slug_history (
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, version)
);
CREATE INDEX slug_history_slug ON slug_history (slug);
""",
    ),
    (
        # A server-edition extra (SPEC §9): addresses a site had on an older
        # engine that now live elsewhere, written when a site moves over
        # (old_addresses.py answers them with a 301).
        "0004_old_addresses",
        """
CREATE TABLE old_addresses (
  path TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL
);
""",
    ),
    (
        # cloudflare/migrations/0012_setup_codes.sql: one-time setup codes
        # issued after deploy (the server edition's `setup-link`), stored
        # only as hashes, each with an expiry; claiming the site deletes them.
        "0005_setup_codes",
        """
CREATE TABLE setup_codes (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
""",
    ),
    (
        # Small values the Cloudflare edition keeps in KV: today, the daily
        # update check's answer (updates.py, SPEC §4 Updates).
        "0006_kv_cache",
        """
CREATE TABLE kv_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
""",
    ),
    (
        # cloudflare/migrations/0013_analytics_daily.sql: a day's counts, kept
        # once its page views pass their 90 days (SPEC §8).
        "0007_analytics_daily",
        """
CREATE TABLE analytics_daily (
  day TEXT PRIMARY KEY,
  visits INTEGER NOT NULL,
  views INTEGER NOT NULL,
  engaged_ms BIGINT NOT NULL
);
""",
    ),
    (
        # cloudflare/migrations/0014_share_cards.sql: which stored image is
        # each entry's share card, at which version (SPEC §5).
        "0008_share_cards",
        """
CREATE TABLE share_cards (
  item_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
""",
    ),
    (
        # cloudflare/migrations/0015_assistant_keys.sql: bearer keys for
        # assistants that can't connect with sign-in (SPEC §4).
        "0009_assistant_keys",
        """
CREATE TABLE assistant_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
""",
    ),
    (
        # Site-version extension kept outside JSON read by earlier bundles.
        "0010_embed_sources",
        """
CREATE TABLE site_embed_sources (
  version INTEGER PRIMARY KEY,
  sources TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0
);
""",
    ),
    (
        "0011_site_fields",
        """
CREATE TABLE site_fields (
  version INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (version, key)
);
""",
    ),
    ("0012_private_auth", """
CREATE TABLE private_approvals (
  version INTEGER PRIMARY KEY
);
CREATE TABLE auth_state (
  id INTEGER PRIMARY KEY,
  owner_epoch INTEGER NOT NULL DEFAULT 0,
  private_floor TEXT NOT NULL DEFAULT ''
);
INSERT INTO auth_state (id) VALUES (1);
CREATE TABLE owner_session_auth (
  token_hash TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  epoch INTEGER NOT NULL
);
CREATE TABLE auth_operations (id TEXT PRIMARY KEY);
CREATE TABLE readers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE reader_passkeys (
  id TEXT PRIMARY KEY,
  reader_id TEXT NOT NULL,
  public_key BYTEA NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE reader_sessions (
  token_hash TEXT PRIMARY KEY,
  reader_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE reader_invites (
  token_hash TEXT PRIMARY KEY,
  reader_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE recovery_codes (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
"""),
    ("0013_approval_alerts", """
-- Device settings are separate from versioned content and legacy auth JSON.
CREATE TABLE alert_keys (id INTEGER PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL);
CREATE TABLE alert_subscriptions (
  id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE,
  credential_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  origin TEXT NOT NULL, label TEXT NOT NULL, created_at BIGINT NOT NULL,
  last_used_at BIGINT, last_claim_at BIGINT NOT NULL DEFAULT 0,
  opened_at BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE alert_deliveries (
  request_id TEXT NOT NULL, subscription_id TEXT NOT NULL REFERENCES alert_subscriptions(id) ON DELETE CASCADE,
  claim TEXT NOT NULL UNIQUE, attempted INTEGER NOT NULL, created_at BIGINT NOT NULL,
  PRIMARY KEY (request_id, subscription_id)
);
CREATE INDEX alert_deliveries_age ON alert_deliveries(created_at,claim);
"""),
    ("0014_stream_settings", """
CREATE TABLE site_stream_settings (
 version INTEGER PRIMARY KEY,
 settings TEXT NOT NULL,
 approved INTEGER NOT NULL DEFAULT 0
);
"""),
    ("0015_agent_traffic_daily", """
CREATE TABLE agent_traffic_daily (
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('search', 'training', 'user', 'other')),
  requests BIGINT NOT NULL DEFAULT 0 CHECK (requests >= 0),
  PRIMARY KEY (day, kind)
);
"""),
    ("0016_training_approvals", """
-- No backfill from approved fields: older code can approve unseen keys.
CREATE TABLE training_approvals (version INTEGER PRIMARY KEY);
"""),
    ("0017_public_artifacts", """
CREATE TABLE public_artifact_state (
 id INTEGER PRIMARY KEY,
 generation TEXT NOT NULL DEFAULT '',
 revision BIGINT NOT NULL DEFAULT 0,
 preparing TEXT NOT NULL DEFAULT '',
 prepare_until BIGINT NOT NULL DEFAULT 0
);
INSERT INTO public_artifact_state(id) VALUES(1);
CREATE TABLE public_artifacts (
 key TEXT PRIMARY KEY,
 generation TEXT NOT NULL,
 body TEXT NOT NULL,
 metadata TEXT NOT NULL,
 valid_until BIGINT NOT NULL,
 size INTEGER NOT NULL
);
"""),
    ("0018_agent_read_keys", """
-- Published-only credentials are deliberately unknown to old writer lookups.
CREATE TABLE agent_read_keys (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 key_hash TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 last_used_at TEXT,
 revoked_at TEXT,
 owner_epoch INTEGER NOT NULL
);
CREATE TABLE agent_read_key_events (
 id TEXT PRIMARY KEY,
 created_at TEXT NOT NULL,
 actor TEXT NOT NULL,
 key_id TEXT NOT NULL,
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('created','revoked'))
);

"""),
    ("0019_agent_read_sessions", """
-- Opaque validator identities, never session grants or stored private content.
CREATE TABLE agent_read_session_ids (
 kind TEXT NOT NULL CHECK(kind IN ('owner','reader')),
 session_hash TEXT NOT NULL,
 id TEXT NOT NULL UNIQUE,
 PRIMARY KEY(kind,session_hash)
);
"""),

]

# Any constant: serializes concurrent startups applying the schema.
_LOCK = 0x5175_7E5C


def now() -> str:
    """new Date().toISOString()"""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def dumps(v: Any) -> str:
    """JSON.stringify(v)"""
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


@asynccontextmanager
async def transaction(db: Db) -> AsyncIterator[asyncpg.Connection]:
    """All or nothing, like a D1 batch."""
    if isinstance(db, asyncpg.Pool):
        async with db.acquire() as conn, conn.transaction():
            yield conn
    else:
        async with db.transaction():
            yield db


async def apply_schema(db: Db) -> list[str]:
    """Create what's missing and run migrations not yet applied; returns their names."""
    applied: list[str] = []
    async with transaction(db) as c:
        await c.execute("SELECT pg_advisory_xact_lock($1)", _LOCK)
        await c.execute(SCHEMA.read_text(encoding="utf-8"))
        done = {r["name"] for r in await c.fetch("SELECT name FROM schema_migrations")}
        for name, sql in MIGRATIONS:
            if name in done:
                continue
            await c.execute(sql)
            await c.execute(
                "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", name, now()
            )
            applied.append(name)
    return applied


async def connect(dsn: str, **kwargs: Any) -> asyncpg.Pool:
    """A pool with the schema applied."""
    pool = await asyncpg.create_pool(dsn, **kwargs)
    await apply_schema(pool)
    return pool
