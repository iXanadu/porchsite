# Porchsite, server edition

The same product as the Cloudflare edition, on your own server: Python
(FastAPI) and PostgreSQL. Pages are rendered per request from the shared
looks in `themes/`, and both editions render every look's sample site to
the same bytes (`scripts/parity.sh`).

- `server/app/`: the web app (`server.app.main:app`): the site, the owner's
  review pages, the assistant's MCP endpoint with OAuth, and an admin CLI
  (`python -m server.app.cli`).
- `server/spec/`: the shared view, ported from the Cloudflare edition's.

## Run it

Use Docker Compose: [`deploy/compose/README.md`](../deploy/compose/README.md)
sets up the app, PostgreSQL and HTTPS on one machine.

The reverse proxy terminates TLS and redirects external HTTP to HTTPS. The
application accepts plain HTTP upstream requests with the public Host header;
it does not redirect by scheme. Keep the upstream port private to the proxy.

## Develop

Python 3.13, then:

```bash
pip install -e ".[dev]"
PORCHSITE_TEST_DSN=postgresql://user@localhost:5432/postgres pytest -q
```

The tests need a PostgreSQL where they may create and drop databases.
From the repository root, `scripts/conformance-server.sh` runs the spec's
safety check against this edition.
