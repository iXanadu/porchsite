// The Grok Bot template's skills, built for one release (scripts/downloads.sh).
// The sources are downloads/skills/<name>/SKILL.md; the helper's pins
// ({{release}}, {{date}}, {{commit}}, {{guides}}, {{files}}) are filled from
// the release being built, so the published skills never lag a release.
// Served at porchsite.dev/skills/ (downloads/board/index.ts):
//   /skills/manifest.json            {version, skills: [{name, url, sha256}]}
//   /skills/<name>/SKILL.md
//
//   node scripts/skills.mjs build <release dir (v/<id>)> <out dir> <release id> <commit> <changelog.json>
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SKILLS_URL = "https://porchsite.dev/skills";
const SOURCES = "downloads/skills";

// The guides the helper pins, in its order: [label, path in the repo].
export const GUIDES = [
  ["install.md", "cloudflare/INSTALL.md"],
  ["llms.txt", "cloudflare/downloads/llms.txt"],
  ["assistants.md (setting up an assistant, with the cost instructions)", "cloudflare/downloads/assistants.md"],
  ["self-hosting.md", "cloudflare/downloads/self-hosting.md"],
  ["authoring.md (making looks)", "cloudflare/downloads/authoring.md"],
];

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** Fill one skill's pins. `guide(path)` gives a guide's bytes at the commit; `files` is [[name, sha256]]. */
export function render(text, { release, date, commit, guide, files }) {
  const guides = GUIDES.map(([label, p]) => `- ${label}: https://raw.githubusercontent.com/iXanadu/porchsite/${commit}/${p} (sha256 \`${sha256(guide(p))}\`)`).join("\n");
  const list = files.map(([name, hash]) => `- ${name}: \`${hash}\``).join("\n");
  const vars = { release, date, commit, guides, files: list };
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`skills: unknown pin ${m}`);
    return vars[k];
  });
}

/** The release's files, as the helper lists them: sitekeeper.js, then the migrations in order. */
export function releaseFiles(dir) {
  const migrations = fs.readdirSync(path.join(dir, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  if (!fs.existsSync(path.join(dir, "sitekeeper.js")) || !migrations.length) throw new Error(`skills: ${dir} has no sitekeeper.js or migrations`);
  return [["sitekeeper.js", "sitekeeper.js"], ...migrations.map((f) => [f, `migrations/${f}`])].map(([name, rel]) => [name, sha256(fs.readFileSync(path.join(dir, rel)))]);
}

export function build({ sources = SOURCES, releaseDir, out, release, commit, date, guide }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`skills: ${commit} is not a full commit id`);
  if (!commit.startsWith(release.split("-").pop())) throw new Error(`skills: release ${release} does not name commit ${commit}`);
  const files = releaseFiles(releaseDir);
  const names = fs.readdirSync(sources).filter((n) => fs.existsSync(path.join(sources, n, "SKILL.md"))).sort();
  if (!names.length) throw new Error(`skills: no skills under ${sources}`);
  const skills = names.map((name) => {
    const text = render(fs.readFileSync(path.join(sources, name, "SKILL.md"), "utf8"), { release, date, commit, guide, files });
    if (!text.startsWith(`---\nname: ${name}\n`)) throw new Error(`skills: ${name}/SKILL.md must start with its name`);
    fs.mkdirSync(path.join(out, name), { recursive: true });
    fs.writeFileSync(path.join(out, name, "SKILL.md"), text);
    return { name, url: `${SKILLS_URL}/${name}/SKILL.md`, sha256: sha256(text) };
  });
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ version: release, skills }, null, 2) + "\n");
  return skills;
}

if (process.argv[2] === "build") {
  const [releaseDir, out, release, commit, changelog] = process.argv.slice(3);
  const entry = JSON.parse(fs.readFileSync(changelog, "utf8")).releases.find((r) => r.release === release);
  if (!entry) throw new Error(`skills: no changelog entry for ${release}`);
  const guide = (p) => execFileSync("git", ["show", `${commit}:${p}`], { maxBuffer: 1 << 26 });
  for (const s of build({ releaseDir, out, release, commit, date: entry.date, guide })) console.log(`skill ${s.name} ${s.sha256}`);
} else if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.error("usage: node scripts/skills.mjs build <release dir> <out dir> <release id> <commit> <changelog.json>");
  process.exit(2);
}
