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
