#!/usr/bin/env bash
# Native owner review bodies and every header, public and private sites.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
: "${PORCHSITE_TEST_DSN:?set disposable test PostgreSQL DSN}"
OUT="${PORCHSITE_OWNER_REVIEW_PARITY_OUTPUT:-$(mktemp -d "${TMPDIR:-/tmp}/owner-review-parity.XXXXXX")}"
trap 'if [ -z "${PORCHSITE_OWNER_REVIEW_PARITY_OUTPUT:-}" ]; then rm -rf "$OUT"; fi' EXIT
mkdir -p "$OUT/cf" "$OUT/server"
(cd "$ROOT/cloudflare" && OWNER_REVIEW_PARITY_OUTPUT="$OUT/cf" npx vitest run --config vitest.owner-review.config.ts --update)
(cd "$ROOT/server" && OWNER_REVIEW_PARITY_OUTPUT="$OUT/server" "$PYTHON" -m pytest -q tests/app/test_owner_review.py)
"$PYTHON" - "$OUT" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]);total=0
for cf in sorted((root/'cf').glob('*.json')):
    left=json.loads(cf.read_text());right=json.loads((root/'server'/cf.name).read_text())
    for a,b in zip(left,right,strict=True):
        # httpx includes ASGI release middleware; Worker tests call handle directly.
        assert b['headers'].pop('x-porchsite-release')=='test'
        assert 'x-porchsite-release' not in a['headers']
        assert a==b,f"owner review differs: {cf.name} {a['path']}"
    total+=len(left)
print(f'owner review parity: {total} representations identical, including every projection header (outer ASGI release header verified separately)')
PY
