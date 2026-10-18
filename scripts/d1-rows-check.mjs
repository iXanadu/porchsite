#!/usr/bin/env node
// Release row-cost gate. --record is an explicit pre-commit preparation step;
// the default check never changes the committed measurement file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fixtures, hash, CLOCK, ORIGIN, HEADERS, COMPATIBILITY } from './d1-rows/fixtures.mjs';
import { measure } from './d1-rows/measure.mjs';
import { compare, printComparison, validate } from './d1-rows/record.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'spec/fixtures/d1-rows.json';
const LOCK = '/tmp/porchsite-suite.lock';
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const git = (...values) => execFileSync('git', values, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const load = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const release = option('--release');

function entries() {
  const list = load(path.join(ROOT, 'changelog.json')).releases;
  if (!release) return { previous: list[0] };
  assert.equal(list[0].release, release, 'row gate release is not newest changelog entry');
  assert(list[1], 'previous published release required');
  return { current: list[0], previous: list[1] };
}

function sourceFingerprint() {
  const paths = git('ls-files', 'cloudflare/src', 'cloudflare/migrations', 'themes', 'shared', 'cloudflare/package-lock.json', 'cloudflare/wrangler.jsonc', 'server/server/app/agent-traffic.json', 'server/server/app/read-unicode.json', 'server/server/app/site-state-guide.json').split('\n').filter(Boolean).sort();
  return hash(JSON.stringify(paths.map(name => [name, hash(fs.readFileSync(path.join(ROOT, name)))])));
}

async function execute(out) {
  assert(fs.statSync(LOCK).isDirectory(), 'suite lock required');
  assert(Date.now() < Date.parse(CLOCK), 'fixture clock expired: explicit baseline rebase required');
  const require = createRequire(path.join(ROOT, 'cloudflare/package.json'));
  const esbuild = require('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const corpus = await fixtures(ROOT, esbuild, out);
  const observerFiles = ['fixtures.mjs','harness.mjs','measure.mjs','observer.mjs','record.mjs','sql-statements.mjs'].map(file => [file, hash(fs.readFileSync(path.join(ROOT, 'scripts/d1-rows', file)))]);
  const inputs = hash(JSON.stringify({ format: 1, seeds: corpus.map(({ name, sha256 }) => ({ name, sha256 })), clock: CLOCK, origin: ORIGIN, headers: HEADERS, compatibility: COMPATIBILITY, node: process.version, esbuild: esbuild.version, miniflare: require('miniflare/package.json').version, observerFiles }));
  const { current, previous } = entries();
  assert.match(previous.release, /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]{7,40}$/);
  const previousRevision = previous.release.split('-')[1];
  const archive = path.join(option('--archives') ?? path.join(ROOT, 'cloudflare/downloads/releases'), previous.release);
  const bundle = path.join(archive, 'sitekeeper.js');
  assert(fs.existsSync(bundle), 'previous archived Worker is missing');
  const archivedHash = hash(fs.readFileSync(bundle));
  // Verify the locally restored archive against its published release manifest.
  const manifestPaths = [path.join(archive, 'files.json'), path.join(option('--manifests') ?? path.join(ROOT, 'cloudflare/downloads/dist/v'), previous.release, 'files.json')];
  const manifestPath = manifestPaths.find(file => fs.existsSync(file));
  assert(manifestPath, 'previous release files.json required to certify archive');
  const manifest = load(manifestPath);
  assert.equal(manifest.version, previous.release, 'archive manifest release mismatch');
  assert.equal(manifest.files.find(file => file.path === 'sitekeeper.js')?.sha256, archivedHash, 'previous archived Worker hash mismatch');
  let prior;
  try { prior = JSON.parse(git('show', `${previousRevision}:${FILE}`)); }
  catch (error) {
    // Only absence is bootstrap. A malformed existing record is never ignored.
    const present = git('ls-tree', previousRevision, '--', FILE);
    if (present) throw error;
  }
  let document = fs.existsSync(path.join(ROOT, FILE)) ? load(path.join(ROOT, FILE)) : null;
  let baseline = prior?.current;
  let bootstrap;
  let rebased;
  if (baseline && baseline.inputs_sha256 !== inputs) {
    validate(baseline);
    if (flag('--record') && flag('--rebase')) {
      const measuredPrevious = await measure({ root: ROOT, out: path.join(out, 'previous'), bundle, migrations: path.join(archive, 'migrations'), corpus, source: hash('git:' + git('rev-parse', previousRevision)), inputs, Miniflare, convertV4MiniflareOptions });
      rebased = { release: previous.release, artifact_sha256: archivedHash, original_record: baseline, record: measuredPrevious };
    } else {
      rebased = document?.rebased_previous;
      assert.equal(rebased?.release, previous.release, 'measurement inputs changed: explicit --record --rebase required');
      assert.equal(rebased?.artifact_sha256, archivedHash, 'rebased archive mismatch');
      assert.deepEqual(rebased?.original_record, baseline, 'original previous record must be retained');
      assert.equal(rebased?.record?.artifact_sha256, archivedHash);
    }
    baseline = rebased.record;
  }
  if (!baseline) {
    if (flag('--record')) {
      baseline = await measure({ root: ROOT, out: path.join(out, 'previous'), bundle, migrations: path.join(archive, 'migrations'), corpus, source: hash('git:' + git('rev-parse', previousRevision)), inputs, Miniflare, convertV4MiniflareOptions });
      bootstrap = { release: previous.release, artifact_sha256: archivedHash, record: baseline };
    } else {
      bootstrap = document?.bootstrap_previous;
      assert.equal(bootstrap?.release, previous.release, 'bootstrap predecessor mismatch');
      assert.equal(bootstrap?.artifact_sha256, archivedHash, 'bootstrap artifact mismatch');
      assert.equal(bootstrap?.record?.artifact_sha256, archivedHash);
      baseline = bootstrap.record;
    }
  }
  validate(baseline);
  assert.equal(baseline.inputs_sha256, inputs, 'measurement inputs changed: explicit previous-release rebase required');
  const configuration = { name: 'porchsite-rows-gate', main: path.join(ROOT, 'cloudflare/src/index.ts'), compatibility_date: COMPATIBILITY.compatibilityDate, compatibility_flags: COMPATIBILITY.compatibilityFlags, define: { __RELEASE__: JSON.stringify('rows-gate-v1') } };
  const configFile = path.join(out, 'wrangler.json');
  fs.writeFileSync(configFile, JSON.stringify(configuration));
  execFileSync(process.execPath, [path.join(ROOT, 'cloudflare/node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run', '--minify', '--config', configFile, '--outdir', path.join(out, 'build')], { cwd: out, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 45_000 });
  const built = fs.readdirSync(path.join(out, 'build')).filter(file => file.endsWith('.js'));
  assert.equal(built.length, 1, 'one emitted application module required');
  const measured = await measure({ root: ROOT, out: path.join(out, 'current'), bundle: path.join(out, 'build', built[0]), migrations: path.join(ROOT, 'cloudflare/migrations'), corpus, source: sourceFingerprint(), inputs, Miniflare, convertV4MiniflareOptions });
  if (flag('--record')) {
    document = { format: 1, current: measured, ...(bootstrap ? { bootstrap_previous: bootstrap } : {}), ...(rebased ? { rebased_previous: rebased } : {}) };
    fs.writeFileSync(path.join(ROOT, FILE), JSON.stringify(document, null, 2) + '\n');
    console.log('Prepared committed row record; commit it before the release check.');
  } else {
    assert(document, 'committed row record missing; prepare and commit it');
    assert.equal(document.format, 1);
    assert.deepEqual(document.current, measured, 'committed row record is stale or differs from the native measurement');
    // A working-tree record cannot replace a committed candidate record.
    assert.equal(git('show', `HEAD:${FILE}`), fs.readFileSync(path.join(ROOT, FILE), 'utf8').trim(), 'row record must be committed');
  }
  fs.writeFileSync(path.join(out, 'measurement.json'), JSON.stringify({ current: measured, previous: baseline }, null, 2) + '\n');
  printComparison(measured, baseline, current?.rows_justification);
  const increases = compare(measured, baseline, current?.rows_justification);
  console.log(`D1 rows gate PASS (${increases.length} justified increases).`);
}

async function main() {
  if (flag('--execute')) { await execute(option('--output')); return; }
  let owned;
  if (flag('--lock-held')) assert(fs.statSync(LOCK).isDirectory(), 'caller-owned suite lock required');
  else { fs.mkdirSync(LOCK); owned = fs.statSync(LOCK).ino; }
  const out = option('--output') ? path.resolve(option('--output')) : fs.mkdtempSync(path.join(os.tmpdir(), 'porchsite-d1-rows-'));
  fs.mkdirSync(out, { recursive: true });
  const started = Date.now();
  let child, timedOut = false;
  try {
    const code = await new Promise((resolve, reject) => {
      const forwarded = ['--archives', '--manifests'].flatMap(name => option(name) ? [name, path.resolve(option(name))] : []);
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--execute', '--output', out, ...forwarded, ...(flag('--record') ? ['--record'] : []), ...(flag('--rebase') ? ['--rebase'] : []), ...(release ? ['--release', release] : [])], { cwd: ROOT, stdio: 'inherit', detached: true });
      const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      const timer = setTimeout(() => { timedOut = true; stop(); }, 118_000);
      const terminate = () => { timedOut = true; stop(); };
      process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', value => { clearTimeout(timer); process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', terminate); stop(); resolve(value); });
    });
    assert(!timedOut, 'D1 rows gate exceeded 120 second budget');
    assert.equal(code, 0, 'D1 rows gate failed');
  } finally {
    if (owned && fs.existsSync(LOCK) && fs.statSync(LOCK).ino === owned) fs.rmdirSync(LOCK);
    fs.writeFileSync(path.join(out, 'cleanup.json'), JSON.stringify({ seconds: (Date.now() - started) / 1000, timed_out: timedOut, owned_lock_released: owned ? !fs.existsSync(LOCK) : null }));
  }
}

main().catch(error => { console.error(`D1 rows gate refused: ${error.message}`); process.exitCode = 1; });
