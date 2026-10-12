#!/usr/bin/env bash
# Parity: both editions render every look's sample site (themes/*/sample.json)
# at the same fixed clock; every page must come out byte for byte the same.
#   scripts/parity.sh [look ...]
# PYTHON picks the server edition's interpreter (default: python3 on PATH);
# NOW the clock (default 2026-10-15T15:30:00Z).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
NOW="${NOW:-2026-10-15T15:30:00Z}"
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

[ "$bad" -eq 0 ] && echo "parity: ${#looks[@]}/${#looks[@]} looks identical" || echo "parity: $bad of ${#looks[@]} looks differ"
exit $((bad > 0))
