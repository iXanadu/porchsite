// The skills build (scripts/skills.mjs): every pin is filled from the release
// being built, the manifest's hashes are the files', and a bad input refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, GUIDES, SKILLS_URL } from './skills.mjs';

const sources = resolve(dirname(fileURLToPath(import.meta.url)), '../downloads/skills');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const COMMIT = 'abc1234'.padEnd(40, '0');
const RELEASE = '2026.01.01-abc1234';

function release(root) {
  const dir = join(root, 'v');
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  writeFileSync(join(dir, 'sitekeeper.js'), 'bundle');
  writeFileSync(join(dir, 'migrations/0002_b.sql'), 'b');
  writeFileSync(join(dir, 'migrations/0001_a.sql'), 'a');
  return dir;
}
const guide = (p) => Buffer.from(`guide ${p}`);

test('the skills build for a release: every pin filled, the manifest names each file by its hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-check-'));
  try {
    const out = join(root, 'out');
    const made = build({ sources, releaseDir: release(root), out, release: RELEASE, commit: COMMIT, date: '2026-01-01', guide });
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, RELEASE);
    assert.deepEqual(manifest.skills.map((s) => s.name), ['porchsite-getting-started', 'porchsite-website-helper']);
    for (const s of manifest.skills) {
      const text = readFileSync(join(out, s.name, 'SKILL.md'), 'utf8');
      assert.equal(s.sha256, sha(text));
      assert.equal(s.url, `${SKILLS_URL}/${s.name}/SKILL.md`);
      assert.doesNotMatch(text, /\{\{/);
    }
    assert.deepEqual(made, manifest.skills);
    const helper = readFileSync(join(out, 'porchsite-website-helper/SKILL.md'), 'utf8');
    assert.match(helper, new RegExp(`pinned to one Porchsite release: \`${RELEASE}\`\\*\\* \\(released 2026-01-01, commit \`${COMMIT}\`, GitHub tag \`release/${RELEASE}\`\\)`));
    assert.match(helper, new RegExp(`releases/tag/release/${RELEASE}\n`));
    for (const [label, p] of GUIDES) assert.ok(helper.includes(`- ${label}: https://raw.githubusercontent.com/iXanadu/porchsite/${COMMIT}/${p} (sha256 \`${sha(guide(p))}\`)`), p);
    assert.ok(helper.includes(`- sitekeeper.js: \`${sha('bundle')}\`\n- 0001_a.sql: \`${sha('a')}\`\n- 0002_b.sql: \`${sha('b')}\`\n\n`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the skills build refuses a short commit, a release naming another commit, an unknown pin, or no release files', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-check-'));
  try {
    const releaseDir = release(root);
    const go = (o) => () => build({ sources, releaseDir, out: join(root, 'out'), release: RELEASE, commit: COMMIT, date: '2026-01-01', guide, ...o });
    assert.throws(go({ commit: 'abc1234' }), /not a full commit/);
    assert.throws(go({ commit: 'def5678'.padEnd(40, '0') }), /does not name commit/);
    const bad = join(root, 'bad/x');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'SKILL.md'), '---\nname: x\n---\n{{nope}}\n');
    assert.throws(go({ sources: join(root, 'bad') }), /unknown pin \{\{nope\}\}/);
    rmSync(join(releaseDir, 'sitekeeper.js'));
    assert.throws(go({}), /no sitekeeper.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the publish check passes only when GitHub, every host and the install path agree', async () => {
  const { check, REPO, TEMPLATE, TEMPLATE_NAME } = await import('./skills-publish-check.mjs');
  const skill = Buffer.from('---\nname: porchsite-website-helper\n---\n');
  const manifest = Buffer.from(JSON.stringify({ version: RELEASE, skills: [{ name: 'porchsite-website-helper', url: `${SKILLS_URL}/porchsite-website-helper/SKILL.md`, sha256: sha(skill) }] }));
  const site = (over = {}) => ({
    [`${REPO}/releases/download/release/${RELEASE}/skills-manifest.json`]: manifest,
    [`${REPO}/releases/download/release/${RELEASE}/porchsite-website-helper.SKILL.md`]: skill,
    'https://porchsite.dev/skills/manifest.json': manifest,
    'https://porchsite.dev/skills/porchsite-website-helper/SKILL.md': skill,
    'https://get.porchsite.dev/skills/manifest.json': manifest,
    'https://get.porchsite.dev/skills/porchsite-website-helper/SKILL.md': skill,
    'https://get.porchsite.dev/assistants.md': Buffer.from(`Install it from ${TEMPLATE}`),
    [TEMPLATE]: Buffer.from(`<title>${TEMPLATE_NAME}</title>`),
    ...over,
  });
  const fetcher = (files) => async (url) => (files[url] ? new Response(files[url]) : new Response('', { status: 404 }));
  assert.deepEqual(await check(RELEASE, undefined, fetcher(site())), []);
  // porchsite.dev still on an older manifest: named, and only that host.
  const old = Buffer.from(JSON.stringify({ version: '2025.12.31-0000000', skills: [] }));
  const stale = await check(RELEASE, undefined, fetcher(site({ 'https://porchsite.dev/skills/manifest.json': old })));
  assert.deepEqual(stale, ['porchsite.dev/skills: manifest.json differs from GitHub\'s (it says version 2025.12.31-0000000)']);
  assert.deepEqual(await check(RELEASE, ['get.porchsite.dev'], fetcher(site({ 'https://porchsite.dev/skills/manifest.json': old }))), []);
  // A changed skill, a missing GitHub copy, a lost template link.
  assert.match((await check(RELEASE, ['get.porchsite.dev'], fetcher(site({ 'https://get.porchsite.dev/skills/porchsite-website-helper/SKILL.md': Buffer.from('x') })))).join(), /get.porchsite.dev porchsite-website-helper: SKILL.md hashes to/);
  assert.match((await check(RELEASE, undefined, fetcher(site({ [`${REPO}/releases/download/release/${RELEASE}/skills-manifest.json`]: undefined })))).join(), /GitHub: .*answered 404/);
  assert.match((await check(RELEASE, undefined, fetcher(site({ 'https://get.porchsite.dev/assistants.md': Buffer.from('gone') })))).join(), /no longer links/);
});
