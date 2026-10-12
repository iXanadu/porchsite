// The changelog (changelog.json at the repository root), for scripts/downloads.sh.
//
//   node scripts/changelog.mjs check <changelog.json> <release id>
//     Refuses (exit 1) unless the changelog is well formed, has an entry for
//     this release at the top, every earlier release is still archived in
//     downloads/releases, and the entry's migrations and reconnect agree with
//     what changed since the previous release. Prints the previous release id.
//   node scripts/changelog.mjs publish <changelog.json> <release id> <out dir> <commit>
//     Adds this release's lines to <out>/latest.json (and all_migrations:
//     every migration file in order, {name, url, sha256}) and writes
//     <out>/changelog.json, <out>/changelog.md (/docs/changelog/) and
//     <out>/changelog/index.html.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RELEASE_ID = /^(\d{4})\.(\d{2})\.(\d{2})-([0-9a-f]{7,40})$/;
const MIGRATION = /^\d{4}_[a-z0-9_]+\.sql$/;
const HOME = process.env.HOME_URL || "https://get.porchsite.dev";

function fail(msg) {
  console.error(`changelog: ${msg}`);
  process.exit(1);
}

function load(file) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${file}: ${e.message}`);
  }
  const list = doc?.releases;
  if (!Array.isArray(list) || !list.length) fail("no releases");
  const seen = new Set();
  let last = "9999-99-99";
  for (const [i, r] of list.entries()) {
    const where = `releases[${i}] (${r?.release})`;
    const m = RELEASE_ID.exec(r?.release ?? "");
    if (!m) fail(`${where}: release must be <YYYY.MM.DD>-<commit>`);
    if (seen.has(r.release)) fail(`${where}: listed twice`);
    seen.add(r.release);
    if (r.date !== `${m[1]}-${m[2]}-${m[3]}`) fail(`${where}: date must be ${m[1]}-${m[2]}-${m[3]}, the release id's day`);
    if (r.date > last) fail(`${where}: newest first, please`);
    last = r.date;
    for (const k of ["security", "reconnect"]) if (typeof r[k] !== "boolean") fail(`${where}: ${k} must be true or false`);
    if (!Array.isArray(r.migrations) || !r.migrations.every((x) => MIGRATION.test(x))) fail(`${where}: migrations must list NNNN_name.sql files`);
    const lines = r.changes;
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > 6) fail(`${where}: changes needs 1 to 6 lines (2-6 when the release changes sites)`);
    for (const l of lines) if (typeof l !== "string" || !l.trim() || l.length > 300 || /\n/.test(l)) fail(`${where}: each change is one plain line under 300 characters`);
    const extra = Object.keys(r).filter((k) => !["release", "date", "security", "reconnect", "migrations", "changes"].includes(k));
    if (extra.length) fail(`${where}: unknown field ${extra.join(", ")}`);
  }
  return list;
}

/** The assistant tools' names, from mcp.ts as the given commit has it (null: the working tree). */
function tools(commit) {
  const show = (p) => execFileSync("git", ["show", `${commit}:${p}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let src;
  if (!commit) src = readFileSync("src/mcp.ts", "utf8");
  else {
    try {
      src = show("cloudflare/src/mcp.ts");
    } catch {
      src = show("src/mcp.ts"); // before the repositories merged
    }
  }
  return [...src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
}

function check(file, version) {
  const list = load(file);
  const at = list.findIndex((r) => r.release === version);
  if (at < 0) fail(`no entry for ${version}. Add it at the top of changelog.json (date, 2-6 plain lines, security, reconnect, migrations) before building.`);
  if (at !== 0) fail(`${version} must be the newest entry (it is number ${at + 1})`);
  const entry = list[0];
  for (const r of list.slice(1)) {
    if (!existsSync(path.join("downloads/releases", r.release, "sitekeeper.js"))) {
      fail(`release ${r.release} is no longer archived in downloads/releases: every release stays downloadable, restore it before publishing`);
    }
  }
  const prev = list[1];
  if (!prev) return "";
  const had = new Set(readdirSync(path.join("downloads/releases", prev.release, "migrations")));
  const added = readdirSync("migrations").filter((f) => f.endsWith(".sql") && !had.has(f)).sort();
  const said = [...entry.migrations].sort();
  if (JSON.stringify(added) !== JSON.stringify(said)) {
    fail(`${version}: migrations says [${said.join(", ")}], but the new files since ${prev.release} are [${added.join(", ")}]`);
  }
  const before = tools(prev.release.split("-")[1]);
  const now = tools(null);
  if (JSON.stringify(before) !== JSON.stringify(now) && !entry.reconnect) {
    const gone = before.filter((t) => !now.includes(t));
    const come = now.filter((t) => !before.includes(t));
    fail(`${version}: the tool list changed since ${prev.release} (added ${come.join(", ") || "none"}; removed ${gone.join(", ") || "none"}): set reconnect to true`);
  }
  return prev.release;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" })[c]);

function markdown(list) {
  const out = [
    "# Porchsite changelog",
    "",
    "Every release, newest first. Porchsite never updates itself: the owner decides,",
    `and their assistant follows "Updating" in the install guide (${HOME}/install.md)`,
    `or, for the server edition, "Updating the server edition" (${HOME}/self-hosting.md).`,
    `Every release stays downloadable at ${HOME}/v/<release>/. The same data: ${HOME}/changelog.json.`,
    `Each release's files and their hashes: ${HOME}/v/<release>/files.json, shaped`,
    '`{"version": "<release>", "files": [{"path": "sitekeeper.js", "url": "...", "bytes": 1600000, "sha256": "..."}, ...]}`.',
    `The newest release: ${HOME}/latest.json (its \`files\` have the same shape; \`all_migrations\``,
    "lists every database file in the order to apply them, each with `name`, `url` and `sha256`).",
    "",
  ];
  for (const r of list) {
    out.push(`## ${r.release}`, "");
    if (r.security) out.push("**Security release: update soon.**", "");
    for (const l of r.changes) out.push(`- ${l}`);
    out.push("");
    out.push(`Database files to apply first (Cloudflare edition): ${r.migrations.length ? r.migrations.join(", ") : "none"}.`);
    out.push(`Reconnect the assistant afterwards: ${r.reconnect ? "yes, the tool list changed" : "no"}.`);
    out.push("");
  }
  return out.join("\n");
}

function htmlPage(list) {
  const css =
    "body{margin:0;background:#f3f2f2;color:#201e1d;font:17px/1.6 Georgia,serif}main{max-width:46em;margin:0 auto;padding:32px 16px 64px}a{color:#00647f}h2{font-size:20px;margin:2em 0 .2em;overflow-wrap:anywhere}.meta{font:14px/1.5 ui-monospace,Menlo,monospace;color:#5c5755}.sec{background:#fff;border-left:4px solid #a4161a;padding:6px 12px;font-weight:bold}li{margin:.3em 0}";
  const rows = list
    .map(
      (r) => `<section id="${esc(r.release)}"><h2>${esc(r.release)}</h2>${r.security ? `<p class="sec">Security release: update soon.</p>` : ""}<ul>${r.changes.map((l) => `<li>${esc(l)}</li>`).join("")}</ul><p class="meta">Database files first (Cloudflare): ${r.migrations.length ? esc(r.migrations.join(", ")) : "none"} · Reconnect the assistant: ${r.reconnect ? "yes" : "no"} · <a href="/v/${esc(r.release)}/files.json">files and hashes</a></p></section>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Changelog · Porchsite</title><style>${css}</style></head>
<body><main><p><a href="https://porchsite.dev/">Porchsite</a> · <a href="/docs/">Guides</a></p><h1>What changed</h1>
<p>Every release, newest first. Porchsite never updates itself: the owner decides, and their assistant follows <a href="/docs/install/#updating">Updating</a> (server edition: <a href="/docs/self-hosting/#updating-the-server-edition">Updating the server edition</a>). Every release stays downloadable; the same list for scripts is <a href="/changelog.json">changelog.json</a>.</p>
${rows}</main></body></html>
`;
}

// The public repository: every release from 2026.10.12-da1480d on is also a
// GitHub release there, the same files under their base names, so an assistant
// whose network can't reach HOME downloads the same bytes (same sha256).
const REPO = "https://github.com/iXanadu/porchsite";
const mirrorOf = (version, p) => `${REPO}/releases/download/release/${version}/${p.split("/").pop()}`;

function publish(file, version, out, commit) {
  const list = load(file);
  const at = list.findIndex((r) => r.release === version);
  if (at < 0) fail(`no entry for ${version}`);
  const shipped = list.slice(at);
  const entry = shipped[0];
  const latestFile = path.join(out, "latest.json");
  const latest = JSON.parse(readFileSync(latestFile, "utf8"));
  latest.files = latest.files.map((f) => ({ ...f, mirror: mirrorOf(version, f.path) }));
  Object.assign(latest, {
    commit,
    changes: entry.changes,
    security: entry.security,
    migrations: entry.migrations,
    // Every migration file, in the order to apply them, so an assistant that
    // skipped releases applies each one its site's _sitekeeper_migrations lacks.
    all_migrations: latest.files
      .filter((f) => f.path.startsWith("migrations/"))
      .map((f) => ({ name: f.path.slice("migrations/".length), url: f.url, mirror: f.mirror, sha256: f.sha256 }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    reconnect: entry.reconnect,
    changelog_url: `${HOME}/changelog/`,
    // Each release's own files and hashes, for a rollback or a check of what a site runs.
    releases: shipped.map((r) => ({ ...r, files_url: `${HOME}/v/${r.release}/files.json` })),
  });
  writeFileSync(latestFile, `${JSON.stringify(latest, null, 2)}\n`);
  writeFileSync(path.join(out, "changelog.json"), `${JSON.stringify({ releases: shipped }, null, 2)}\n`);
  writeFileSync(path.join(out, "changelog.md"), markdown(shipped));
  mkdirSync(path.join(out, "changelog"), { recursive: true });
  writeFileSync(path.join(out, "changelog", "index.html"), htmlPage(shipped));
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "check" && args.length === 2) console.log(check(...args));
else if (cmd === "publish" && args.length === 4) publish(...args);
else fail("usage: changelog.mjs check <changelog.json> <release> | publish <changelog.json> <release> <out> <commit>");
