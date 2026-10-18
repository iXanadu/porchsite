#!/bin/sh
# Build the downloads site (get.porchsite.dev): the install guide, llms.txt, and the bundle under
# v/<version>/ with latest.json naming it, plus the changelog.
# Deploy: cd downloads && npx wrangler deploy -c wrangler.local.jsonc (the real database id lives there, untracked).
#
# A release is built only when it is safe to update to and to roll back from:
#   - the code is committed (the release id names the commit; only
#     changelog.json may be uncommitted, since its entry names this commit);
#   - changelog.json has an entry for this release id, and its migrations and
#     reconnect agree with what actually changed since the previous release;
#   - every earlier release in changelog.json is still archived in
#     downloads/releases (they are all re-published under v/);
#   - the full local gates pass (there is no hosted CI; these are the
#     checks): the Cloudflare edition's typecheck, tests and theme check, the
#     server edition's tests, scripts/parity.sh,
#     scripts/conformance-server.sh and scripts/conformance-mutations.sh
#     (the check still catches each deliberately broken rule);
#   - scripts/migration-check.py and scripts/upgrade-check.sh pass: schema
#     changes are additive, and the previous release runs on the new schema.
#   - no tag release/<id> exists on another commit (a tag is never moved).
# After a build: the commit is tagged release/<id> (annotated, its changelog
# lines as the message) and the tag is pushed (never forced; a GitHub tag on
# another commit stops the script), then the release's files go to a GitHub
# release on that tag, the second copy of downloads/releases and
# releases-themes (scripts/archive-restore.sh reads it back). If the push or
# the upload can't happen, the build still stands: a warning says so and
# prints the commands to run later, in order.
# Needs PORCHSITE_TEST_DSN and PYTHON (the server edition's interpreter) for
# the server tests, conformance and the upgrade check.
set -eu
cd "$(dirname "$0")/.."
# The address comes from src/home.ts, so the code and the files agree.
HOME_URL="$(sed -n 's/^export const HOME = "\(.*\)";$/\1/p' src/home.ts)"
export HOME_URL
VERSION="$(date -u +%Y.%m.%d)-$(git rev-parse --short HEAD)"
export VERSION

DIRTY="$(git -C .. status --porcelain --untracked-files=no | grep -v ' changelog.json$' || true)"
if [ -n "$DIRTY" ]; then
  echo "refusing to build $VERSION: commit these first (the release id names the commit):" >&2
  echo "$DIRTY" >&2
  exit 1
fi

# The release's tag. It names this commit or it doesn't exist yet; an existing
# tag on another commit is never moved.
TAG="release/$VERSION"
COMMIT="$(git rev-parse HEAD)"
tagged() { git rev-parse -q --verify "refs/tags/$TAG^{commit}" || true; }
if [ -n "$(tagged)" ] && [ "$(tagged)" != "$COMMIT" ]; then
  echo "refusing to build $VERSION: tag $TAG already exists on $(tagged), not on $COMMIT; a release tag is never moved" >&2
  exit 1
fi

# The full local gates, on the commit being released.
: "${PORCHSITE_TEST_DSN:?set PORCHSITE_TEST_DSN (a PostgreSQL the server tests may create databases on)}"
echo "gates: Cloudflare typecheck, tests, theme check"
npm run --silent typecheck
npx vitest run --reporter=dot
npm run --silent theme:check
echo "gates: server tests"
(cd ../server && PYTHONPATH="$PWD" "${PYTHON:-python3}" -m pytest -q)
echo "gates: production runtime startup"
"${PYTHON:-python3}" ../scripts/runtime-smoke.py --lock-held
echo "gates: parity, conformance"
PYTHON="${PYTHON:-python3}" bash ../scripts/parity.sh
PYTHON="${PYTHON:-python3}" bash ../scripts/conformance-server.sh
PYTHON="${PYTHON:-python3}" bash ../scripts/conformance-mutations.sh

# The changelog entry, checked against what changed; prints the previous release.
PREV="$(node scripts/changelog.mjs check ../changelog.json "$VERSION")"
echo "gates: D1 rows read and written (previous release comparison)"
node ../scripts/d1-rows-check.mjs --lock-held --release "$VERSION"
if [ -n "$PREV" ]; then
  sh ../scripts/upgrade-check.sh "$PREV"
else
  echo "no earlier release: skipping the upgrade check"
  "${PYTHON:-python3}" ../scripts/migration-check.py
fi

RELEASE="$VERSION" sh scripts/bundle.sh >/dev/null
# A published release never changes: rebuilding one must give the same files.
if [ -e "downloads/releases/$VERSION" ]; then
  if ! cmp -s dist/sitekeeper.js "downloads/releases/$VERSION/sitekeeper.js" \
    || ! diff -r -q dist/migrations "downloads/releases/$VERSION/migrations" >/dev/null; then
    echo "refusing: $VERSION is already published with other files (downloads/releases/$VERSION); a release never changes" >&2
    exit 1
  fi
fi
OUT=downloads/dist
rm -rf "$OUT"
mkdir -p "$OUT/v/$VERSION/migrations"
cp downloads/index.html downloads/llms.txt downloads/robots.txt downloads/_headers "$OUT/"
cp INSTALL.md "$OUT/install.md"
cp CONTRIBUTING-THEMES.md "$OUT/contributing-themes.md"
cp downloads/authoring.md "$OUT/authoring.md"
cp downloads/self-hosting.md "$OUT/self-hosting.md"
cp downloads/assistants.md "$OUT/assistants.md"
cp ../spec/TEMPLATES.md "$OUT/templates.md"
for f in "$OUT"/*.md "$OUT"/*.txt "$OUT"/index.html; do
  sed -i.bak "s#https://get.sitekeeper.dev#$HOME_URL#g" "$f" && rm -f "$f.bak"
done
cp dist/sitekeeper.js "$OUT/v/$VERSION/"
cp dist/migrations/*.sql "$OUT/v/$VERSION/migrations/"
node - "$OUT" "$VERSION" <<'JS'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [out, version] = process.argv.slice(2);
const base = path.join(out, "v", version);
const rel = ["sitekeeper.js", ...fs.readdirSync(path.join(base, "migrations")).sort().map((f) => `migrations/${f}`)];
const files = rel.map((r) => {
  const b = fs.readFileSync(path.join(base, r));
  return { path: r, url: `${process.env.HOME_URL}/v/${version}/${r}`, bytes: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex") };
});
fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify({ version, released: new Date().toISOString().slice(0, 10), install: `${process.env.HOME_URL}/install.md`, files }, null, 2) + "\n");
JS
# The changelog: its lines in latest.json, and /changelog.json, /changelog/
# and changelog.md (shown at /docs/changelog/).
node scripts/changelog.mjs publish ../changelog.json "$VERSION" "$OUT" "$(git rev-parse HEAD)"
# The look files this build adds (they go into this release's GitHub copy).
THEMES_BEFORE="$(mktemp)"
(cd downloads && find releases-themes -type f 2>/dev/null | LC_ALL=C sort) >"$THEMES_BEFORE"
# Previews: each theme's sample site, rendered and photographed once per
# version (kept with the theme's releases).
TMP="$(mktemp -d)"
for dir in ../themes/*/; do
  name="$(basename "$dir")"
  version="$(node -p "require('../themes/$name/template.json').version")"
  keep="downloads/releases-themes/$name"
  if [ -f "../themes/$name/sample.json" ] && [ ! -f "$keep/$version-phone.png" ]; then
    mkdir -p "$keep"
    node scripts/theme.mjs render "$name" ../themes "$TMP/$name" >/dev/null
    node scripts/previews.cjs "$TMP/$name" "$keep/$version"
  fi
done
rm -rf "$TMP"

# The theme catalog: each theme as one package at themes/<name>/<version>.json
# (immutable), and themes.json listing them with their slots and checksums.
# Credit (an X handle, nothing else) comes from themes/credits.json, which the
# curator keeps; it goes in themes.json, never in a package (scripts/catalog.mjs).
node - "$OUT" <<'JS'
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { pathToFileURL } = require("url");
(async () => {
const { parseCredits, catalogEntry } = await import(pathToFileURL(path.resolve("scripts/catalog.mjs")).href);
const { themePackage } = await import(pathToFileURL(path.resolve("scripts/theme-version.mjs")).href);
const out = process.argv[2];
const root = "../themes";
const names = fs.readdirSync(root).sort().filter((n) => fs.statSync(path.join(root, n)).isDirectory());
const creditsFile = path.join(root, "credits.json");
const credits = parseCredits(fs.existsSync(creditsFile) ? fs.readFileSync(creditsFile, "utf8") : "{}", names);
const list = [];
for (const name of names) {
  const dir = path.join(root, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "template.json"), "utf8"));
  const pkg = themePackage(dir);
  const rel = `themes/${name}/${manifest.version}.json`;
  // A published version never changes: a changed theme needs a new version.
  const kept = path.join("downloads/releases-themes", name, `${manifest.version}.json`);
  if (fs.existsSync(kept) && fs.readFileSync(kept, "utf8") !== pkg) {
    console.error(`theme ${name} changed since ${manifest.version} was published: bump its version in template.json`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, pkg);
  fs.mkdirSync(path.join(out, "themes", name), { recursive: true });
  fs.writeFileSync(path.join(out, rel), pkg);
  const previews = ["phone", "desktop"]
    .filter((l) => fs.existsSync(path.join("downloads/releases-themes", name, `${manifest.version}-${l}.png`)))
    .map((label) => ({ label, url: `${process.env.HOME_URL}/themes/${name}/${manifest.version}-${label}.png` }));
  list.push(catalogEntry(manifest, credits, previews, { url: `${process.env.HOME_URL}/${rel}`, sha256: crypto.createHash("sha256").update(pkg).digest("hex"), bytes: Buffer.byteLength(pkg) }));
}
fs.writeFileSync(path.join(out, "themes.json"), JSON.stringify({ themes: list }, null, 2) + "\n");
})().catch((e) => { console.error(e.message); process.exit(1); });
JS

cp -R downloads/releases-themes/. "$OUT/themes/"

# Every released version stays downloadable: keep each one, and ship them all.
# downloads/releases is not in git; its second copy is on GitHub (below).
mkdir -p downloads/releases
cp -R "$OUT/v/$VERSION" downloads/releases/
cp -R downloads/releases/. "$OUT/v/"
# Each version's files with their hashes, at v/<version>/files.json, so a
# rollback to any version can be checked.
node - "$OUT/v" <<'JS'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const root = process.argv[2];
for (const version of fs.readdirSync(root).sort()) {
  const base = path.join(root, version);
  const rel = ["sitekeeper.js", ...fs.readdirSync(path.join(base, "migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => `migrations/${f}`)];
  const files = rel.map((r) => {
    const b = fs.readFileSync(path.join(base, r));
    return { path: r, url: `${process.env.HOME_URL}/v/${version}/${r}`, bytes: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex") };
  });
  fs.writeFileSync(path.join(base, "files.json"), JSON.stringify({ version, files }, null, 2) + "\n");
}
JS
echo "built $OUT ($VERSION; $(ls downloads/releases | wc -l | tr -d ' ') versions)"

# The tag: annotated, its changelog lines as the message.
NOTES="downloads/releases-upload/$VERSION.notes.md"
UP="downloads/releases-upload/$VERSION"
rm -rf "$UP"
mkdir -p "$UP"
node -e '
const [file, id] = process.argv.slice(1);
const r = JSON.parse(require("fs").readFileSync(file, "utf8")).releases.find((x) => x.release === id);
process.stdout.write(r.changes.map((l) => `- ${l}`).join("\n") + "\n");
' ../changelog.json "$VERSION" >"$NOTES"
if [ -z "$(tagged)" ]; then
  { printf 'Porchsite %s\n\n' "$VERSION"; cat "$NOTES"; } | git tag -a "$TAG" -F - "$COMMIT"
  echo "tagged $TAG (annotated, on $COMMIT)"
elif [ "$(tagged)" = "$COMMIT" ]; then
  echo "tag $TAG already names this commit"
else
  echo "refusing to tag: $TAG now exists on $(tagged), not on $COMMIT; a release tag is never moved" >&2
  exit 1
fi

# The second copy: this release's files as the GitHub release $TAG. The bundle
# (sitekeeper.js, the migrations, files.json), archive-files.json (every
# version's files.json, so older copies can be checked too), the look files
# this build added (themes.tar.gz) and themes-files.json (every look file's
# hash). The files stay in $UP until the next build of this version.
cp "$OUT/v/$VERSION/sitekeeper.js" "$OUT/v/$VERSION/files.json" "$UP/"
cp "$OUT/v/$VERSION/migrations/"*.sql "$UP/"
NEW_THEMES="$(mktemp)"
(cd downloads && find releases-themes -type f | LC_ALL=C sort) | comm -13 "$THEMES_BEFORE" - >"$NEW_THEMES"
if [ -s "$NEW_THEMES" ]; then
  COPYFILE_DISABLE=1 tar -czf "$UP/themes.tar.gz" -C downloads -T "$NEW_THEMES"
fi
rm -f "$THEMES_BEFORE" "$NEW_THEMES"
node - "$OUT/v" downloads/releases-themes "$UP" <<'JS'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [v, themes, up] = process.argv.slice(2);
const releases = fs.readdirSync(v).sort().map((id) => JSON.parse(fs.readFileSync(path.join(v, id, "files.json"), "utf8")));
fs.writeFileSync(path.join(up, "archive-files.json"), JSON.stringify({ releases }, null, 2) + "\n");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = walk(themes).sort().map((f) => {
  const b = fs.readFileSync(f);
  return { path: path.relative(themes, f).split(path.sep).join("/"), bytes: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex") };
});
fs.writeFileSync(path.join(up, "themes-files.json"), JSON.stringify({ files }, null, 2) + "\n");
JS
PUSH="git push origin refs/tags/$TAG"
UPLOAD="gh release create '$TAG' $UP/* --verify-tag --prerelease --title '$VERSION' --notes-file '$NOTES'"
banner() {
  {
    echo
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    for line in "$@"; do echo "!! $line"; done
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo
  } >&2
}
later() { # later <why> <command...>: the build stands; say what to run
  why="$1"
  shift
  banner "WARNING: $VERSION is NOT copied to GitHub: $why" \
    "downloads/releases is its only copy until you run, in order (from cloudflare/):" "$@"
}
# The tag goes to GitHub first (the release is made on it), never forced.
if REMOTE="$(git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}" 2>/dev/null)"; then
  REMOTE_TAG="$(printf '%s\n' "$REMOTE" | sort -k2 -r | sed -n '1s/[[:space:]].*//p')"
  if [ -n "$REMOTE_TAG" ] && [ "$REMOTE_TAG" != "$COMMIT" ]; then
    banner "STOP: GitHub's tag $TAG names $REMOTE_TAG, not $COMMIT ($VERSION)." \
      "A release tag is never moved: nothing was pushed or uploaded. Find out why before releasing."
    exit 1
  fi
  if [ -n "$REMOTE_TAG" ]; then
    echo "GitHub already has $TAG on this commit"
    PUSHED=1
  elif git push --quiet origin "refs/tags/$TAG"; then
    echo "pushed $TAG"
    PUSHED=1
  else
    PUSHED=
  fi
else
  PUSHED=
fi
if [ -z "$PUSHED" ]; then
  later "the tag could not be pushed (offline?)" "  $PUSH" "  $UPLOAD"
elif ! command -v gh >/dev/null 2>&1; then
  later "gh is not installed" "  $UPLOAD"
elif ! gh auth status >/dev/null 2>&1; then
  later "gh is not signed in (gh auth login)" "  $UPLOAD"
elif gh release view "$TAG" >/dev/null 2>&1; then
  echo "GitHub release $TAG already exists: not uploaded again"
elif gh release create "$TAG" "$UP"/* --verify-tag --prerelease --title "$VERSION" --notes-file "$NOTES" >/dev/null; then
  echo "copied to the GitHub release $TAG"
else
  later "gh release create failed" "  $UPLOAD"
fi
