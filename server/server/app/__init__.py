"""The server edition's engine: storage and services ported behaviour for
behaviour from the Cloudflare edition (cloudflare/src) onto PostgreSQL.
Module and function names follow the TypeScript ones (snake_case), so the
two editions read side by side: content.ts -> content.py, and so on.

Every function takes the database first (an asyncpg pool or connection), as
the TypeScript takes its D1 binding. Every content write goes through
content.py, so versions, idempotency, revisions and the guard always apply.
"""
