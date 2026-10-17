// Exercise the actual npm gate in an isolated copy; never mutate a real look.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { themePackage } from './theme-version.mjs';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('theme:check refuses changed published bytes until the version is bumped', () => {
  const root = mkdtempSync(join(tmpdir(), 'theme-version-check-'));
  try {
    const cf = join(root, 'cloudflare');
    mkdirSync(join(cf, 'scripts'), { recursive: true });
    for (const file of ['theme.mjs', 'theme.ts', 'theme-version.mjs', 'catalog.mjs'])
      cpSync(join(source, 'scripts', file), join(cf, 'scripts', file));
    cpSync(join(source, 'src'), join(cf, 'src'), { recursive: true });
    cpSync(join(source, '../themes'), join(root, 'themes'), { recursive: true });
    cpSync(join(source, 'package.json'), join(cf, 'package.json'));
    symlinkSync(join(source, 'node_modules'), join(cf, 'node_modules'), 'dir');
    const dir = join(root, 'themes/personal-homepage');
    const manifestFile = join(dir, 'template.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const archive = join(cf, 'downloads/releases-themes/personal-homepage');
    mkdirSync(archive, { recursive: true });
    const git = args => {
      const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    git(['init', '--quiet']);
    git(['add', 'themes']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m',
      'Publish look fixture\n\nCo-Authored-By: Codex gpt-6 <noreply@openai.com>']);
    git(['tag', 'release/test-fixture']);
    const frozen = themePackage(dir);
    const kept = join(archive, `${manifest.version}.json`);
    writeFileSync(kept, frozen);
    const gate = () => spawnSync('npm', ['run', '--silent', 'theme:check', '--', 'personal-homepage'],
      { cwd: cf, encoding: 'utf8', timeout: 30000, env: { ...process.env, TMPDIR: root } });
    const pass = () => { const r = gate(); assert.equal(r.status, 0, r.stdout + r.stderr); };
    pass();
    const home = join(dir, 'home.mustache');
    writeFileSync(home, readFileSync(home, 'utf8') + '\n<!-- published package changed -->\n');
    let result = gate();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /changed since .* was published: bump its version/);
    // The gate must only read the archive, including when it fails.
    assert.equal(readFileSync(kept, 'utf8'), frozen);
    // Missing ignored archives must not disable the check in a worktree.
    rmSync(kept);
    result = gate();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /changed since .* was published: bump its version/);
    manifest.version = '99.0.0';
    writeFileSync(manifestFile, JSON.stringify(manifest));
    pass();
    assert.equal(existsSync(join(archive, '99.0.0.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
