#!/usr/bin/env bash
# The conformance check (spec/conformance/check.py) against the server
# edition, end to end: a throwaway database, the web app under uvicorn on a
# free local port, an assistant token from the admin CLI, the check, then
# everything torn down.
#   scripts/conformance-server.sh
# PYTHON picks the server edition's interpreter (default: python3 on PATH);
# PORCHSITE_TEST_DSN (required) the PostgreSQL cluster to make the database
# on, as for the server edition's tests.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
ADMIN_DSN="${PORCHSITE_TEST_DSN:?set PORCHSITE_TEST_DSN (a PostgreSQL where databases may be created and dropped)}"
NAME="porchsite_conformance_$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 8)"
export PYTHONPATH="${CONFORMANCE_EXTRA_PATH:+$CONFORMANCE_EXTRA_PATH:}$ROOT/server"
LOG="$(mktemp "${TMPDIR:-/tmp}/conformance-server.XXXXXX")"

db() { # db create|drop
  "$PYTHON" - "$1" "$ADMIN_DSN" "$NAME" <<'EOF'
import asyncio, sys
import asyncpg

async def main(what, dsn, name):
    c = await asyncpg.connect(dsn)
    try:
        if what == "create":
            await c.execute(f'CREATE DATABASE "{name}"')
        else:
            await c.execute(f'DROP DATABASE IF EXISTS "{name}"')
    finally:
        await c.close()

asyncio.run(main(*sys.argv[1:]))
EOF
}

DSN="$("$PYTHON" -c 'import sys; from urllib.parse import urlsplit, urlunsplit; p = urlsplit(sys.argv[1]); print(urlunsplit((p.scheme, p.netloc, "/" + sys.argv[2], p.query, "")))' "$ADMIN_DSN" "$NAME")"
PORT="$("$PYTHON" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
SITE="http://127.0.0.1:$PORT"
PID=""

cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  # The app has closed its pool. Plain DROP also handles autovacuum without
  # requiring the test role to have permission to signal other roles.
  # 70 distinguishes cleanup failures from expected conformance failures.
  if ! db drop; then
    echo "! could not drop $NAME" >&2
    status=70
  fi
  rm -f "$LOG"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

db create || { echo "✗ could not create a database on $ADMIN_DSN"; exit 1; }

PORCHSITE_DSN="$DSN" PORCHSITE_RELEASE="conformance" PORCHSITE_SETUP_CODE="" \
  "$PYTHON" -m uvicorn server.app.main:app --host 127.0.0.1 --port "$PORT" --log-level warning >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 100); do
  "$PYTHON" -c 'import sys, httpx; httpx.get(sys.argv[1] + "/robots.txt", timeout=1).raise_for_status()' "$SITE" 2>/dev/null && break
  if ! kill -0 "$PID" 2>/dev/null; then echo "✗ the server didn't start:"; cat "$LOG"; exit 1; fi
  sleep 0.1
done

TOKEN="$(PORCHSITE_DSN="$DSN" "$PYTHON" -m server.app.cli token --name conformance --origin "$SITE")" || {
  echo "✗ could not mint a token"
  exit 1
}

"$PYTHON" "$ROOT/spec/conformance/check.py" "$SITE" --token "$TOKEN"
status=$?
if [ "$status" -ne 0 ]; then
  echo "--- server log"
  cat "$LOG"
fi
exit "$status"
