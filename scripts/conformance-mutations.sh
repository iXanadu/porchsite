#!/usr/bin/env bash
# Does the conformance check notice a broken site? Runs it against the server
# edition once per deliberate mutation (scripts/conformance-mutations/) and
# expects the matching check to FAIL each time.
#   scripts/conformance-mutations.sh
# Same environment as scripts/conformance-server.sh (PYTHON, PORCHSITE_TEST_DSN).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bad=0
while IFS='|' read -r mutation expect; do
  [ -z "$mutation" ] && continue
  out="$(PORCHSITE_MUTATION="$mutation" CONFORMANCE_EXTRA_PATH="$ROOT/scripts/conformance-mutations" "$ROOT/scripts/conformance-server.sh" 2>&1)"
  if grep -q "^FAIL  $expect" <<<"$out"; then
    echo "✓ $mutation: caught by \"$expect\""
  else
    echo "✗ $mutation: the check didn't fail \"$expect\""
    grep -E '^(PASS|FAIL)' <<<"$out" | sed 's/^/    /'
    bad=$((bad + 1))
  fi
done <<'LIST'
guard-off|S6 content that looks like a secret is refused
stale-update|S3 an update from an old version is refused
no-replay|S4 a replayed create returns the same item
hotlink|S7 an outside image is copied in or refused, never linked
LIST
[ "$bad" -eq 0 ] && echo "mutations: every one caught" || echo "mutations: $bad not caught"
exit "$bad"
