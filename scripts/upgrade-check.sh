#!/bin/sh
# The upgrade check: the PREVIOUS release must run on the NEW schema, so that
# rolling back is only re-uploading (Cloudflare) or checking out (server) the
# previous release, with no schema step. scripts/downloads.sh runs it before
# every release; run it by hand after changing a migration.
#
#   scripts/upgrade-check.sh [<previous release id>]
#
# Default previous release: the newest one in changelog.json whose code
# differs from what is checked out. It checks, and exits 1 on any failure:
#   1. scripts/migration-check.py: every schema change is additive, and the
#      released migrations are unchanged (append-only since that release).
#   2. Cloudflare: the previous release's own test suite (a git worktree at
#      its commit) on a D1 built from the NEW migrations.
#   3. Cloudflare: the previous release's archived bundle
#      (cloudflare/downloads/releases/<id>/sitekeeper.js, what an owner
#      re-uploads to roll back) served on the NEW migrations: /, /review,
#      /setup, /login, OAuth metadata, /mcp.
#   4. Server: the previous release's test suite, each database built with
#      the NEW schema first and then the previous release's own startup
#      schema step on top (scripts/upgrade/new_schema.py), less the few
#      explained exceptions in scripts/upgrade/known-failures.txt.
#   5. BOTH previous runtimes on the same databases populated through the
#      current release's content, approval, media and analytics APIs. Public
#      pages/feed must remain HTTP 200 and owner passkey sign-in must work.
#
# Needs: git, node (cloudflare/node_modules installed), PYTHON (the server
# edition's virtualenv python; default python3) and PORCHSITE_TEST_DSN (a
# PostgreSQL where the tests may create and drop databases).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
cd "$ROOT"

say() { printf '%s\n' "upgrade-check: $*"; }
die() { printf '%s\n' "upgrade-check: $*" >&2; exit 1; }

: "${PORCHSITE_TEST_DSN:?set PORCHSITE_TEST_DSN (a PostgreSQL the server tests may create databases on)}"

if [ "$#" -ge 1 ]; then
  PREV="$1"
else
  HEAD_SHA="$(git rev-parse --short HEAD)"
  DIRTY="$(git status --porcelain --untracked-files=no -- cloudflare server themes spec | head -1)"
  PREV="$("$PYTHON" - "$HEAD_SHA" "$DIRTY" <<'PY'
import json, sys
head, dirty = sys.argv[1], sys.argv[2]
for r in json.load(open("changelog.json"))["releases"]:
    if dirty or not head.startswith(r["release"].split("-", 1)[1]):
        print(r["release"]); break
PY
)"
fi
[ -n "$PREV" ] || die "no previous release found in changelog.json"
SHA="${PREV#*-}"
git cat-file -e "$SHA^{commit}" 2>/dev/null || die "release $PREV: commit $SHA is not in this repository"
BUNDLE="$ROOT/cloudflare/downloads/releases/$PREV/sitekeeper.js"
[ -f "$BUNDLE" ] || die "release $PREV: no archived bundle at cloudflare/downloads/releases/$PREV (every release must stay downloadable)"
say "from $PREV (commit $SHA) to the working tree"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/porchsite-upgrade.XXXXXX")"
cleanup() {
  git -C "$ROOT" worktree remove --force "$TMP/prev" >/dev/null 2>&1 || true
  git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM
git worktree add --detach --quiet "$TMP/prev" "$SHA"

# 1. The compatibility rule, statically, and append-only since PREV.
"$PYTHON" scripts/migration-check.py --self-test
"$PYTHON" scripts/migration-check.py --base "$SHA"

# 2. The previous Cloudflare code's tests on the new migrations.
(
  cd "$TMP/prev/cloudflare"
  if cmp -s package-lock.json "$ROOT/cloudflare/package-lock.json"; then
    ln -s "$ROOT/cloudflare/node_modules" node_modules
  else
    say "Cloudflare: $PREV has other dependencies; installing them"
    npm ci --silent --no-audit --no-fund >/dev/null
  fi
  rm -f migrations/*.sql
  cp "$ROOT"/cloudflare/migrations/*.sql migrations/
  say "Cloudflare: $PREV's tests on the new migrations ($(ls migrations | wc -l | tr -d ' ') files)"
  if ! npx vitest run >"$TMP/cf.log" 2>&1; then
    tail -40 "$TMP/cf.log" >&2
    die "Cloudflare: $PREV's tests fail on the new migrations"
  fi
  grep -E '^ +(Test Files|Tests) ' "$TMP/cf.log" || tail -4 "$TMP/cf.log"
) || exit 1

# 3. The previous archived bundle, as uploaded, on the new migrations.
(cd "$ROOT/cloudflare" && node scripts/bundle-smoke.mjs "$BUNDLE" migrations "$PREV") \
  || die "Cloudflare: the archived $PREV bundle doesn't serve on the new migrations"

# 4. The previous server code's tests on the new schema, less the known,
# explained failures that apply to this release (scripts/upgrade/known-failures.txt).
SKIP=""
while read -r rel test _why; do
  case "$rel" in ""|\#*) continue ;; esac
  if git merge-base --is-ancestor "$SHA" "${rel#*-}" 2>/dev/null; then
    say "server: skipping $test (known-failures.txt: harmless on rollback)"
    SKIP="$SKIP --deselect $test"
  fi
done < scripts/upgrade/known-failures.txt
(
  cd "$TMP/prev/server"
  say "server: $PREV's tests on the new schema"
  # shellcheck disable=SC2086
  if ! PYTHONPATH="$TMP/prev/server:$ROOT/scripts/upgrade" \
    PORCHSITE_NEW_DB_PY="$ROOT/server/server/app/db.py" PORCHSITE_UPGRADE_MARK="$TMP/mark" \
    "$PYTHON" -m pytest -q -p new_schema -p no:cacheprovider $SKIP >"$TMP/sv.log" 2>&1; then
    tail -40 "$TMP/sv.log" >&2
    die "server: $PREV's tests fail on the new schema"
  fi
  [ -s "$TMP/mark" ] && cat "$TMP/mark" || die "server: the new schema was not applied (plugin not loaded)"
  tail -1 "$TMP/sv.log"
) || exit 1

# 5. A schema-compatible old binary may still reject new content JSON. Seed
# through this checkout first, then restart the actual old bundle/server on
# those populated databases. New tables must not poison old validated rows.
node scripts/upgrade/rollback-data.mjs "$ROOT" "$TMP/prev" "$BUNDLE" "$PREV" \
  || die "previous runtimes cannot read data written by this release"

say "ok: $PREV runs on the new schema and newly written feature data in both editions"
