// After a release is deployed: are the Grok Bot template's skills really
// published for it? A release is NOT done until this passes, in full, against
// porchsite.dev (the address the template is updated from).
//   a) the GitHub release release/<id> carries skills-manifest.json for <id>,
//      and every <name>.SKILL.md hashes to it;
//   b) on each host, /skills/manifest.json is byte-identical to GitHub's, every
//      skill URL in it is exactly https://porchsite.dev/skills/<name>/SKILL.md,
//      and <host>/skills/<name>/SKILL.md hashes to the manifest;
//   c) the install path: get.porchsite.dev/assistants.md links the template,
//      and the template's page answers with its name.
// Exits non-zero, naming every failure.
//
//   node scripts/skills-publish-check.mjs <release id> [--host porchsite.dev] [--host get.porchsite.dev]
// Hosts default to both. --host get.porchsite.dev alone is only for a release
// made before porchsite.dev/skills is served by the downloads Worker.
import crypto from "node:crypto";
import path from "node:path";
import { SKILLS_URL } from "./skills.mjs";

export const REPO = "https://github.com/iXanadu/porchsite";
export const TEMPLATE = "https://x.ai/bot/d7FrbtGVYmwTz7FexYZO4";
export const TEMPLATE_NAME = "Porchsite Website Builder";
const HOSTS = ["porchsite.dev", "get.porchsite.dev"];
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function get(url, fetcher) {
  const r = await fetcher(url, { redirect: "follow", headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Every failure, as plain sentences; empty means published. */
export async function check(release, hosts = HOSTS, fetcher = fetch) {
  const bad = [];
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (e) {
      bad.push(`${what}: ${e.message}`);
    }
  };
  // a) GitHub
  const base = `${REPO}/releases/download/release/${release}`;
  let manifestBytes, manifest;
  await attempt("GitHub", async () => {
    manifestBytes = await get(`${base}/skills-manifest.json`, fetcher);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.version !== release) throw new Error(`skills-manifest.json is for ${manifest.version}, not ${release}`);
    if (!Array.isArray(manifest.skills) || !manifest.skills.length) throw new Error("skills-manifest.json lists no skills");
  });
  if (!manifest) return bad;
  for (const s of manifest.skills) {
    await attempt(`GitHub ${s.name}`, async () => {
      if (s.url !== `${SKILLS_URL}/${s.name}/SKILL.md`) throw new Error(`its URL is ${s.url}, not ${SKILLS_URL}/${s.name}/SKILL.md`);
      const got = sha256(await get(`${base}/${s.name}.SKILL.md`, fetcher));
      if (got !== s.sha256) throw new Error(`${s.name}.SKILL.md hashes to ${got}, the manifest says ${s.sha256}`);
    });
  }
  // b) each host
  for (const host of hosts) {
    await attempt(`${host}/skills`, async () => {
      const live = await get(`https://${host}/skills/manifest.json`, fetcher);
      if (!live.equals(manifestBytes)) {
        let v = "?";
        try {
          v = JSON.parse(live.toString("utf8")).version;
        } catch {}
        throw new Error(`manifest.json differs from GitHub's (it says version ${v})`);
      }
    });
    for (const s of manifest.skills) {
      await attempt(`${host} ${s.name}`, async () => {
        const got = sha256(await get(`https://${host}/skills/${s.name}/SKILL.md`, fetcher));
        if (got !== s.sha256) throw new Error(`SKILL.md hashes to ${got}, the manifest says ${s.sha256}`);
      });
    }
  }
  // c) the install path
  await attempt("install path", async () => {
    const guide = (await get("https://get.porchsite.dev/assistants.md", fetcher)).toString("utf8");
    if (!guide.includes(TEMPLATE)) throw new Error(`get.porchsite.dev/assistants.md no longer links ${TEMPLATE}`);
    const page = (await get(TEMPLATE, fetcher)).toString("utf8");
    if (!page.includes(TEMPLATE_NAME)) throw new Error(`${TEMPLATE} doesn't show "${TEMPLATE_NAME}"`);
  });
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const release = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--host");
  const hosts = args.flatMap((a, i) => (args[i - 1] === "--host" ? [a] : []));
  if (!release || hosts.some((h) => !HOSTS.includes(h))) {
    console.error(`usage: node scripts/skills-publish-check.mjs <release id> [--host ${HOSTS.join("|")}]...`);
    process.exit(2);
  }
  const use = hosts.length ? hosts : HOSTS;
  const bad = await check(release, use);
  if (bad.length) {
    console.error(`SKILLS NOT PUBLISHED for ${release} (${use.join(", ")}):`);
    for (const b of bad) console.error(`  - ${b}`);
    process.exit(1);
  }
  console.log(`skills published for ${release}: GitHub, ${use.join(", ")}, install path`);
  if (!use.includes("porchsite.dev")) console.log("NOT DONE: porchsite.dev was not checked; the release is done only when it passes there too.");
}
