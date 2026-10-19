# Porchsite

## What this is
A website your AI assistant builds and keeps up to date, where nothing goes
live without the owner's yes. Two editions of one product:

- `cloudflare/`: the Cloudflare edition. One Worker on the owner's own
  Cloudflare account (D1 for content, history and images; KV for sign-in).
  This is what non-technical owners install, guided by their assistant.
- `server/`: the server edition. Python (FastAPI) and PostgreSQL, self-hosted
  behind a web server; pages are rendered per request, like the Cloudflare
  edition. The new app is `server/server/app/` (entry `server.app.main:app`)
  on the spec-shaped view in `server/server/spec/`.
- `spec/`: the contract both editions implement (SPEC.md, TEMPLATES.md) and
  the conformance check.
- `themes/`: every look, shared by both editions (TEMPLATES.md).

"Sitekeeper" is the engine's internal name in code and in the spec;
Porchsite is the product's name.

## The rule that keeps two editions honest
A change to behaviour lands in the spec and in BOTH editions, or it is
labelled in the spec as one edition's extra. The parity check proves the
editions render every look's sample site to the same bytes:

```bash
scripts/parity.sh          # both editions render themes/*/sample.json; diff
```

A look that differs is a bug in one edition, not a reason to fork the look.

## Sources of truth
- **The spec**: `spec/SPEC.md`, `spec/TEMPLATES.md`. Change it first.
- **`BACKLOG.md`** (repo root): open work, read every session, updated the
  moment a defect is found or fixed. Done = delete the line in the same
  commit.
- Session notes, handoffs and reports live outside this repo. Never commit
  them.

## This repo is public. Keep it clean.
Write every file and commit message as if a stranger reads it today. Never
commit names of real people, assistants or agents, internal systems,
machines, hosts, accounts or clients; account identifiers; real people's
site URLs, IP addresses, emails or phone numbers; agent reports or session
notes; links to chat sessions; secrets. Use placeholders (`example.com`,
`owner`, `assistant`, RFC 5737 addresses). Public products are not private
names: the assistant apps people use (Claude, ChatGPT, Grok, Meta AI) are
named wherever it helps, as in the guide to setting up your assistant;
what stays out is the private name anyone gave their own assistant or
agent.

Enforced: `.githooks/` runs `scripts/repo-hygiene-check.sh` on every commit.
Enable once per clone: `git config core.hooksPath .githooks`. The denylist
of names is local and never tracked (`.hygiene-denylist`).

## Commands
```bash
# Cloudflare edition
cd cloudflare && npm install && npm test && npm run theme:check
# Server edition (pyenv virtualenv; tests need a Postgres where they may
# create and drop databases: set PORCHSITE_TEST_DSN)
cd server && pip install -e ".[dev]" && pytest -q
scripts/conformance-server.sh   # the spec's safety check against the server edition
scripts/conformance-mutations.sh  # ...and that it catches each rule broken on purpose
# Both
scripts/parity.sh
scripts/migration-check.py      # schema changes are additive only (the compatibility rule)
scripts/upgrade-check.sh        # the previous release's tests and bundle on the new schema
```

There is no hosted CI, by decision: every check runs locally. Releasing
(`cloudflare/scripts/downloads.sh`) runs the full local gates (the
Cloudflare edition's typecheck, tests and theme check, the server
edition's tests, parity, conformance and its mutation runs, the migration
check and the upgrade check) and needs a committed tree and a `changelog.json` entry for the
release id; it refuses otherwise. After the build it tags the commit
`release/<id>` (annotated, never moved), pushes the tag (never forced; a
GitHub tag on another commit stops it), and copies the release's files to a
GitHub release on that tag (`cloudflare/scripts/archive-restore.sh`
restores the archive from those). If the push or upload fails, the build
still stands and the commands to run later are printed. The build also pins
the Grok Bot template's skills (`cloudflare/downloads/skills/`) to the release
and serves them at porchsite.dev/skills/, which the template is updated from;
edit the skills there, never on a live host. No site ever
updates itself (spec §4 Updates).
