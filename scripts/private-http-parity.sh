#!/usr/bin/env bash
# Compare native authorized private HTTP bodies and metadata on all look samples.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
: "${PORCHSITE_TEST_DSN:?set disposable test PostgreSQL DSN}"
OUT="${PORCHSITE_PRIVATE_PARITY_OUTPUT:-$(mktemp -d "${TMPDIR:-/tmp}/private-http-parity.XXXXXX")}"
trap 'if [ -z "${PORCHSITE_PRIVATE_PARITY_OUTPUT:-}" ]; then rm -rf "$OUT"; fi' EXIT
mkdir -p "$OUT/cf" "$OUT/server"
looks=()
for d in "$ROOT"/themes/*/; do [ ! -f "$d/sample.json" ] || looks+=("$(basename "$d")"); done
names="$("$PYTHON" -c 'import json,sys;print(json.dumps(sys.argv[1:]))' "${looks[@]}")"
(cd "$ROOT/cloudflare" && PORCHSITE_PARITY_LOOKS="$names" PORCHSITE_PARITY_OUTPUT="$OUT/cf" npx vitest run --config vitest.private-http.config.ts --update)
PYTHONPATH="$ROOT/server" "$PYTHON" "$ROOT/server/scripts/private_http_parity.py" "$OUT/server" "${looks[@]}"
"$PYTHON" - "$OUT" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]);total=0
for cf in sorted((root/'cf').glob('*.json')):
    left=json.loads(cf.read_text());right=json.loads((root/'server'/cf.name).read_text())
    assert left==right,f'private HTTP differs: {cf.name}'
    total+=len(left)
print(f'private HTTP parity: {len(list((root/"cf").glob("*.json")))} looks, {total} representations identical')
PY
