"""Fixtures for the server edition's services (server/app).

One fresh database per test session (porchsite_test_<random>) on the cluster
named by PORCHSITE_TEST_DSN, dropped at the end. Each test module starts from
empty tables, and tests within a module share state in order, as each
Cloudflare test file shares one D1 database.
"""

import asyncio
import os
import secrets
import threading
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import httpx
import pytest
import pytest_asyncio

from server.app.db import apply_schema

# A PostgreSQL where the tests may create and drop databases. Required, with no
# default: a guess could land on a server that holds real data.
ADMIN_DSN = os.environ.get("PORCHSITE_TEST_DSN", "")
if not ADMIN_DSN:
    raise pytest.UsageError(
        "Set PORCHSITE_TEST_DSN to a PostgreSQL where the tests may create and drop"
        " databases, e.g. postgresql://user@localhost:5432/postgres"
    )

TABLES = (
    "agent_read_session_ids, agent_read_key_events, agent_read_keys, public_artifacts, public_artifact_state, training_approvals, agent_traffic_daily, site_stream_settings, alert_deliveries, alert_subscriptions, alert_keys, private_approvals, owner_session_auth, auth_operations, readers, reader_passkeys, reader_sessions, reader_invites, recovery_codes, site_fields, site_embed_sources, items, revisions, idempotency, live, approvals, publishes, owner, passkeys, sessions, "
    "challenges, media, uploads, passkey_links, themes, request_proofs, theme_requests, "
    "theme_submissions, oauth_clients, oauth_grants, oauth_tokens, oauth_consents, analytics_salts, pageviews, analytics_visitor_counts, slug_history, old_addresses, setup_codes, kv_cache, analytics_daily, share_cards, assistant_keys"
)


def _with_db(dsn: str, name: str) -> str:
    p = urlsplit(dsn)
    return urlunsplit((p.scheme, p.netloc, f"/{name}", p.query, p.fragment))


def _run(coro):
    """Run a coroutine to the end on its own loop, away from the tests' loops."""
    out: dict = {}

    def go():
        try:
            out["value"] = asyncio.run(coro)
        except BaseException as e:  # re-raised in the caller
            out["error"] = e

    th = threading.Thread(target=go)
    th.start()
    th.join()
    if "error" in out:
        raise out["error"]
    return out.get("value")


@pytest.fixture(scope="session")
def test_dsn():
    name = f"porchsite_test_{secrets.token_hex(4)}"

    async def create():
        c = await asyncpg.connect(ADMIN_DSN)
        try:
            await c.execute(f'CREATE DATABASE "{name}"')
        finally:
            await c.close()
        c = await asyncpg.connect(_with_db(ADMIN_DSN, name))
        try:
            await apply_schema(c)
        finally:
            await c.close()

    async def drop():
        c = await asyncpg.connect(ADMIN_DSN)
        try:
            # Dependent app/pool fixtures close first. Plain DROP handles
            # autovacuum without requiring cross-role signal privileges.
            await c.execute(f'DROP DATABASE IF EXISTS "{name}"')
        finally:
            await c.close()

    try:
        _run(create())
        yield _with_db(ADMIN_DSN, name)
    finally:
        try:
            _run(drop())
        except Exception as exc:
            raise RuntimeError(f"could not drop {name}") from exc


@pytest.fixture(scope="module")
def fresh_tables(test_dsn):
    async def truncate():
        c = await asyncpg.connect(test_dsn)
        try:
            await c.execute(f"TRUNCATE {TABLES} RESTART IDENTITY")
            await c.execute("UPDATE analytics_maintenance SET completed_day = '' WHERE id = 1")
            await c.execute("UPDATE auth_state SET owner_epoch = 0, private_floor = '' WHERE id = 1")
        finally:
            await c.close()

    _run(truncate())
    return test_dsn


@pytest_asyncio.fixture
async def db(fresh_tables):
    """A pool on the test database, per test (asyncpg pools belong to one loop)."""
    pool = await asyncpg.create_pool(fresh_tables, min_size=1, max_size=2)
    try:
        yield pool
    finally:
        from server.app import agent_traffic
        await agent_traffic.drain(pool)
        await pool.close()


SITE = "https://site.example"


def pytest_configure(config):
    # The tests pass the owner's session cookie per request, as the Cloudflare
    # tests pass a Cookie header.
    config.addinivalue_line(
        "filterwarnings", "ignore:Setting per-request cookies:DeprecationWarning"
    )


@pytest_asyncio.fixture
async def app(db):
    """The web app (server.app.main) on the test database, started."""
    from server.app.main import create_app
    from server.app.settings import Settings

    a = create_app(Settings(setup_code="test-setup-code", release="test"), pool=db)
    # The app's task group lives in one task from start to stop (a fixture's
    # setup and teardown may run in different tasks).
    up, down = asyncio.Event(), asyncio.Event()

    async def run():
        async with a.started():
            up.set()
            await down.wait()

    task = asyncio.create_task(run())
    await up.wait()
    try:
        yield a
    finally:
        down.set()
        await task


@pytest_asyncio.fixture
async def http(app):
    """An HTTP client talking to the app in process, as a visitor at https://site.example."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=SITE, follow_redirects=False
    ) as c:
        yield c
