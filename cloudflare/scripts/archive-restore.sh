#!/bin/sh
# Rebuild the release archive (downloads/releases and downloads/releases-themes,
# which are not in git) from its second copy on GitHub:
#   - archive-* releases: a tarball of both folders (archive-2026.10.11 holds
#     every release through 2026.10.11-0d1682b);
#   - release/<id> releases, one per later release, made by
#     scripts/downloads.sh: the bundle (sitekeeper.js, the migrations,
#     files.json), archive-files.json (every version's files.json at that
#     release), themes.tar.gz (the look files that release added) and
#     themes-files.json (every look file's hash at that release).
#
#   sh scripts/archive-restore.sh <dir>
#
# Writes <dir>/releases and <dir>/releases-themes; refuses if either exists
# and isn't empty (to restore in place: sh scripts/archive-restore.sh downloads
# once both are gone). Nothing is written there unless everything checks:
#   - every release's files match its files.json (from its own GitHub release,
#     else an archive-files.json, else the live downloads site's
#     v/<id>/files.json), with no file missing and none extra;
#   - every look file matches themes-files.json, or, for a file no manifest
#     names, the same file on the live downloads site;
#   - two copies of one file never differ, and every release in
#     changelog.json is there.
# Needs gh (signed in, with access to the repository) and node.
set -eu
[ "$#" -eq 1 ] || { echo "usage: sh scripts/archive-restore.sh <dir>" >&2; exit 2; }
mkdir -p "$1"
DEST="$(cd "$1" && pwd)"
cd "$(dirname "$0")/.."
for d in releases releases-themes; do
  if [ -d "$DEST/$d" ] && [ -n "$(ls -A "$DEST/$d")" ]; then
    echo "refusing: $DEST/$d exists and isn't empty" >&2
    exit 1
  fi
done
HOME_URL="$(sed -n 's/^export const HOME = "\(.*\)";$/\1/p' src/home.ts)"
gh auth status >/dev/null 2>&1 || { echo "gh is not signed in (gh auth login)" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/archive-restore.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$TMP/dl" "$TMP/x" "$TMP/stage/releases" "$TMP/stage/releases-themes"

TAGS="$(gh release list --limit 1000 --json tagName --jq '.[].tagName' | LC_ALL=C sort)"
ARCHIVES="$(printf '%s\n' "$TAGS" | grep '^archive-' || true)"
RELEASES="$(printf '%s\n' "$TAGS" | grep '^release/' || true)"
[ -n "$ARCHIVES$RELEASES" ] || { echo "no archive-* or release/* releases on GitHub" >&2; exit 1; }

# Each source unpacked into its own folder, then merged and checked.
n=0
for tag in $ARCHIVES; do
  n=$((n + 1))
  echo "downloading $tag"
  gh release download "$tag" --pattern '*.tar.gz' --dir "$TMP/dl/a$n"
  mkdir -p "$TMP/x/a$n"
  for t in "$TMP/dl/a$n"/*.tar.gz; do tar -xzf "$t" -C "$TMP/x/a$n"; done
done
for tag in $RELEASES; do
  n=$((n + 1))
  id="${tag#release/}"
  echo "downloading $tag"
  gh release download "$tag" --dir "$TMP/dl/r$n"
  mkdir -p "$TMP/x/r$n/releases/$id/migrations" "$TMP/x/r$n/manifests"
  cp "$TMP/dl/r$n/sitekeeper.js" "$TMP/x/r$n/releases/$id/"
  for f in "$TMP/dl/r$n"/*.sql; do [ -e "$f" ] && cp "$f" "$TMP/x/r$n/releases/$id/migrations/"; done
  for f in files.json archive-files.json themes-files.json; do
    [ -e "$TMP/dl/r$n/$f" ] && cp "$TMP/dl/r$n/$f" "$TMP/x/r$n/manifests/"
  done
  [ -e "$TMP/dl/r$n/themes.tar.gz" ] && tar -xzf "$TMP/dl/r$n/themes.tar.gz" -C "$TMP/x/r$n"
  printf '%s\n' "$id" >"$TMP/x/r$n/manifests/id"
done

node - "$TMP/x" "$TMP/stage" ../changelog.json "$HOME_URL" <<'JS'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [xroot, stage, changelog, home] = process.argv.slice(2);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const rel = (base, f) => path.relative(base, f).split(path.sep).join("/");
const problems = [];
const bad = (m) => problems.push(m);

// 1. Merge every source into the stage; two copies of a file must agree.
const releaseMan = new Map(); // id -> { from, files }
const themeMan = new Map(); // path -> { from, sha256, bytes }
const addRelease = (from, m) => {
  const prev = releaseMan.get(m.version);
  const key = JSON.stringify(m.files.map((f) => [f.path, f.sha256, f.bytes]));
  if (prev && prev.key !== key) bad(`${m.version}: files.json in ${from} differs from ${prev.from}`);
  else if (!prev) releaseMan.set(m.version, { from, key, files: m.files });
};
for (const src of fs.readdirSync(xroot).sort()) {
  const base = path.join(xroot, src);
  for (const sub of ["releases", "releases-themes"]) {
    for (const f of walk(path.join(base, sub))) {
      const to = path.join(stage, sub, path.relative(path.join(base, sub), f));
      const b = fs.readFileSync(f);
      if (fs.existsSync(to)) {
        if (!fs.readFileSync(to).equals(b)) bad(`${sub}/${rel(path.join(stage, sub), to)}: two copies differ`);
      } else {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, b);
      }
    }
  }
  const man = path.join(base, "manifests");
  if (!fs.existsSync(man)) continue;
  const id = fs.readFileSync(path.join(man, "id"), "utf8").trim();
  const read = (f) => (fs.existsSync(path.join(man, f)) ? JSON.parse(fs.readFileSync(path.join(man, f), "utf8")) : null);
  const own = read("files.json");
  if (own) addRelease(`release/${id}`, own);
  for (const m of read("archive-files.json")?.releases ?? []) addRelease(`release/${id} archive-files.json`, m);
  for (const f of read("themes-files.json")?.files ?? []) {
    const prev = themeMan.get(f.path);
    if (prev && prev.sha256 !== f.sha256) bad(`releases-themes/${f.path}: hashes differ between ${prev.from} and release/${id}`);
    else if (!prev) themeMan.set(f.path, { from: `release/${id}`, ...f });
  }
}

(async () => {
  const fetchBuf = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  // 2. Every release against its files.json.
  const rdir = path.join(stage, "releases");
  const ids = fs.readdirSync(rdir).sort();
  const sources = {};
  for (const id of ids) {
    let man = releaseMan.get(id);
    if (!man) {
      try {
        const m = JSON.parse((await fetchBuf(`${home}/v/${id}/files.json`)).toString("utf8"));
        if (m.version !== id) throw new Error(`names ${m.version}`);
        man = { from: "live site", files: m.files };
      } catch (e) {
        bad(`${id}: no files.json to check it against (${e.message})`);
        continue;
      }
    }
    sources[man.from.replace(/^release\/\S+ /, "")] = (sources[man.from.replace(/^release\/\S+ /, "")] || 0) + 1;
    const have = new Set(walk(path.join(rdir, id)).map((f) => rel(path.join(rdir, id), f)));
    for (const f of man.files) {
      const p = path.join(rdir, id, f.path);
      if (!have.delete(f.path)) { bad(`${id}/${f.path}: missing`); continue; }
      const b = fs.readFileSync(p);
      if (b.length !== f.bytes || sha(b) !== f.sha256) bad(`${id}/${f.path}: hash differs from files.json (${man.from})`);
    }
    for (const extra of have) bad(`${id}/${extra}: not in its files.json`);
  }
  for (const r of JSON.parse(fs.readFileSync(changelog, "utf8")).releases) {
    if (!ids.includes(r.release)) bad(`${r.release}: in changelog.json, not on GitHub`);
  }
  // 3. Every look file against themes-files.json, else the live site.
  const tdir = path.join(stage, "releases-themes");
  const tfiles = walk(tdir).map((f) => rel(tdir, f)).sort();
  let live = 0;
  for (const p of tfiles) {
    const b = fs.readFileSync(path.join(tdir, p));
    const m = themeMan.get(p);
    if (m) {
      themeMan.delete(p);
      if (b.length !== m.bytes || sha(b) !== m.sha256) bad(`releases-themes/${p}: hash differs from themes-files.json (${m.from})`);
      continue;
    }
    try {
      if (!(await fetchBuf(`${home}/themes/${p}`)).equals(b)) bad(`releases-themes/${p}: differs from the live site's copy`);
      live++;
    } catch (e) {
      bad(`releases-themes/${p}: no hash to check it against (${e.message})`);
    }
  }
  for (const [p, m] of themeMan) bad(`releases-themes/${p}: named in themes-files.json (${m.from}) but in no copy`);

  if (problems.length) {
    console.error(`archive-restore: ${problems.length} problem(s); nothing written:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  const how = Object.entries(sources).map(([k, v]) => `${v} by ${k}`).join(", ");
  console.log(`verified ${ids.length} releases (files.json: ${how}) and ${tfiles.length} look files (${tfiles.length - live} by themes-files.json, ${live} by the live site)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
JS

mkdir -p "$DEST/releases" "$DEST/releases-themes"
cp -R "$TMP/stage/releases/." "$DEST/releases/"
cp -R "$TMP/stage/releases-themes/." "$DEST/releases-themes/"
echo "restored into $DEST/releases and $DEST/releases-themes"
