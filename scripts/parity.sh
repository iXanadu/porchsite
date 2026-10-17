#!/usr/bin/env bash
# Parity: both editions render every look's sample site (themes/*/sample.json)
# at the same fixed clock; every page must come out byte for byte the same.
# Also compare real site_check and site_state tool answers on disposable
# local databases (PORCHSITE_TEST_DSN is required; no external calls).
#   scripts/parity.sh [look ...]
#   scripts/parity.sh --self-test   prove the old server URL defect is caught
# PYTHON picks the server edition's interpreter (default: python3 on PATH);
# NOW the clock (default 2026-10-15T15:30:00Z).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
NOW="${NOW:-2026-10-15T15:30:00Z}"
export NOW
: "${PORCHSITE_TEST_DSN:?set PORCHSITE_TEST_DSN (a PostgreSQL where disposable databases may be created and dropped)}"
if [ "${1:-}" = "--self-test" ]; then
  out="$(mktemp "${TMPDIR:-/tmp}/parity-mutation.XXXXXX")"
  trap 'rm "$out"' EXIT
  PORCHSITE_PARITY_MUTATION=legacy-url "$ROOT/scripts/parity.sh" product-page >"$out" 2>&1
  result=$?
  if [ "$result" -ne 0 ] && grep -q '^✗ tool answers differ:' "$out" && grep -q 'url-equivalence.json' "$out"; then
    echo "✓ parity self-test: caught the server's missing URL normalization"
    exit 0
  fi
  cat "$out"
  echo "✗ parity self-test did not catch the server URL defect"
  exit 1
fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/parity.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

looks=("$@")
if [ ${#looks[@]} -eq 0 ]; then
  for d in "$ROOT"/themes/*/; do
    [ -f "$d/sample.json" ] && looks+=("$(basename "$d")")
  done
fi

# The Cloudflare side is bundled once, then run per look.
(cd "$ROOT/cloudflare" && npx esbuild scripts/theme.ts --bundle --platform=node --outfile="$TMP/theme.cjs" --log-level=error) || {
  echo "✗ could not build the Cloudflare renderer"
  exit 1
}

bad=0
for look in "${looks[@]}"; do
  cf="$TMP/cf/$look" py="$TMP/py/$look"
  if ! (cd "$ROOT/cloudflare" && node "$TMP/theme.cjs" raw "$look" "$ROOT/themes" "$cf" "$NOW") >"$TMP/$look.cf.log" 2>&1; then
    echo "✗ $look: the Cloudflare edition failed: $(tail -n 1 "$TMP/$look.cf.log")"
    bad=$((bad + 1))
    continue
  fi
  if ! PYTHONPATH="$ROOT/server" "$PYTHON" "$ROOT/server/scripts/render_sample.py" "$look" "$ROOT/themes/$look/sample.json" "$py" "$NOW" >"$TMP/$look.py.log" 2>&1; then
    echo "✗ $look: the server edition failed: $(tail -n 1 "$TMP/$look.py.log")"
    bad=$((bad + 1))
    continue
  fi
  files_cf="$(cd "$cf" && find . -type f | sort)"
  files_py="$(cd "$py" && find . -type f | sort)"
  differ=()
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -f "$cf/$f" ] || [ ! -f "$py/$f" ] || ! cmp -s "$cf/$f" "$py/$f"; then differ+=("$f"); fi
  done < <(printf '%s\n%s\n' "$files_cf" "$files_py" | sort -u)
  n="$(printf '%s\n' "$files_cf" | grep -c .)"
  if [ ${#differ[@]} -eq 0 ]; then
    echo "✓ $look: $n pages identical"
  else
    bad=$((bad + 1))
    f="${differ[0]#./}"
    if [ ! -f "$cf/$f" ]; then first="only the server edition has $f"
    elif [ ! -f "$py/$f" ]; then first="only the Cloudflare edition has $f"
    else first="$f: $(diff "$cf/$f" "$py/$f" | head -n 3 | tr '\n' ' ' | cut -c1-200)"
    fi
    echo "✗ $look: ${#differ[@]} files differ; first: $first"
  fi
done

# Conditional binary media uses identical bytes, header fields and weak validators.
if ! (cd "$ROOT/cloudflare" && npx esbuild scripts/media-parity.ts --bundle --platform=node --outfile="$TMP/media.cjs" --log-level=error && node "$TMP/media.cjs") >"$TMP/media-cf.json" \
  || ! PYTHONPATH="$ROOT/server" "$PYTHON" "$ROOT/server/scripts/media_parity.py" >"$TMP/media-py.json" \
  || ! cmp -s "$TMP/media-cf.json" "$TMP/media-py.json"; then
  echo "✗ conditional media responses differ"
  bad=$((bad + 1))
else
  echo "✓ conditional media: binary types, GET/HEAD, validators and session isolation identical"
fi

# The tool handlers run in their native runtimes, on the same persisted rows.
# Keep every answer field; sort JSON object keys only, preserving array order.
if ! (cd "$ROOT/cloudflare" && node scripts/tool-parity.mjs "$TMP/tools-cf" "${looks[@]}") >"$TMP/tools.cf.log" 2>&1; then
  echo "✗ Cloudflare tool answers failed:"
  tail -30 "$TMP/tools.cf.log"
  bad=$((bad + 1))
elif ! PYTHONPATH="$ROOT/server" "$PYTHON" "$ROOT/server/scripts/tool_parity.py" "$TMP/tools-py" "${looks[@]}" >"$TMP/tools.py.log" 2>&1; then
  echo "✗ server tool answers failed:"
  tail -30 "$TMP/tools.py.log"
  bad=$((bad + 1))
elif ! diff -ru "$TMP/tools-cf" "$TMP/tools-py" >"$TMP/tools.diff"; then
  echo "✗ tool answers differ:"
  head -60 "$TMP/tools.diff"
  bad=$((bad + 1))
else
  echo "✓ tool answers: ${#looks[@]} samples and regression fixtures identical (site_check quick/deep; site_state summary/full/ids/empty/unknown)"
fi

# Expanded stream settings and the common archive must match for every look.
if (cd "$ROOT/cloudflare" && npx esbuild scripts/stream-parity.ts --bundle --platform=node --format=esm --outfile="$TMP/streams.mjs" --log-level=error) &&
  node "$TMP/streams.mjs" "$ROOT/spec/stream-cases.json" "$TMP/streams-cf.json" &&
  PYTHONPATH="$ROOT/server" "$PYTHON" "$ROOT/server/scripts/stream_parity.py" "$ROOT/spec/stream-cases.json" "$TMP/streams-py.json" &&
  "$PYTHON" - "$TMP/streams-cf.json" "$TMP/streams-py.json" <<'PY'
import json, sys
a, b = [json.load(open(path)) for path in sys.argv[1:]]
if a != b:
    for look in sorted(set(a) | set(b)):
        for page in sorted(set(a.get(look, {})) | set(b.get(look, {}))):
            if a.get(look, {}).get(page) != b.get(look, {}).get(page):
                print(f"stream parity differs: {look}/{page}")
    sys.exit(1)
print("✓ expanded streams: all looks, archive filters, title order, feeds, search and sitemap identical")
PY
then :; else bad=$((bad + 1)); fi

[ "$bad" -eq 0 ] && echo "parity: ${#looks[@]}/${#looks[@]} looks identical" || echo "parity: $bad of ${#looks[@]} looks differ"
exit $((bad > 0))
