// Match the immutable package bytes checked by downloads.sh. No network calls.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageManifest } from './catalog.mjs';

export function themePackage(dir) {
  const read = (sub, ext) => {
    const root = join(dir, sub);
    if (!existsSync(root)) return {};
    return Object.fromEntries(readdirSync(root).filter(f => !ext || f.endsWith(ext))
      .map(f => [ext ? f.slice(0, -ext.length) : f, readFileSync(join(root, f), 'utf8')]));
  };
  return JSON.stringify({
    manifest: packageManifest(JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8'))),
    pages: read('', '.mustache'), partials: read('partials', '.mustache'), static: read('static', ''),
  });
}

export function publishedThemeProblems(root, name, archive = resolve('downloads/releases-themes')) {
  const dir = join(root, name), current = themePackage(dir);
  const { version } = JSON.parse(current).manifest;
  const kept = join(archive, name, `${version}.json`);
  const changed = () => [`theme ${name} changed since ${version} was published: bump its version in template.json`];
  if (existsSync(kept)) return readFileSync(kept, 'utf8') === current ? [] : changed();

  // Ignored archives are absent in fresh clones/worktrees. A release tag
  // provides the committed package source without downloading anything.
  const repo = resolve(root, '..');
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = relative(repo, dir).split('\\').join('/');
  let tags;
  try { tags = git(['tag', '--list', 'release/*', '--sort=-creatordate']).trim().split('\n').filter(Boolean); }
  catch { return []; } // A standalone, unpublished look need not be in Git.
  for (const tag of tags) {
    let manifest;
    try { manifest = JSON.parse(git(['show', `${tag}:${prefix}/template.json`])); }
    catch { continue; } // This look did not exist in that release.
    if (manifest.version !== version) continue;
    const read = (sub, ext) => {
      const base = `${prefix}/${sub}`;
      let names;
      try { names = git(['ls-tree', '--name-only', `${tag}:${base.replace(/\/$/, '')}`]).trim().split('\n').filter(Boolean); }
      catch { return {}; }
      return Object.fromEntries(names.filter(f => !ext || f.endsWith(ext))
        .map(f => [ext ? f.slice(0, -ext.length) : f, git(['show', `${tag}:${base}${f}`])]));
    };
    const previous = JSON.stringify({ manifest: packageManifest(manifest), pages: read('', '.mustache'),
      partials: read('partials/', '.mustache'), static: read('static/', '') });
    return previous === current ? [] : changed();
  }
  return []; // A new look or a new, unpublished version.
}
