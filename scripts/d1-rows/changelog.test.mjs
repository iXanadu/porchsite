import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('published justification stays visible, escaped, and optional for older entries', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'porchsite-row-changelog-'));
  try {
    const release = '2026.10.18-abcdef0', reason = 'One extra indexed write <reviewed> & approved.';
    const previous = { release:'2026.10.17-abcdef1', date:'2026-10-17', security:false, reconnect:false, migrations:[], changes:['Previous release.'] };
    const entry = { ...previous, release, date:'2026-10-18', changes:['Measured row check.'], rows_justification:reason };
    const file=path.join(out,'input.json');
    fs.writeFileSync(file,JSON.stringify({releases:[entry,previous]}));
    fs.writeFileSync(path.join(out,'latest.json'),JSON.stringify({files:[{path:'sitekeeper.js',url:'https://example.com/sitekeeper.js',sha256:'a'.repeat(64)}]}));
    const publish=()=>spawnSync(process.execPath,[path.join(root,'cloudflare/scripts/changelog.mjs'),'publish',file,release,out,'a'.repeat(40)],{encoding:'utf8'});
    assert.equal(publish().status,0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out,'changelog.json'))).releases[0].rows_justification,reason);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out,'latest.json'))).releases[0].rows_justification,reason);
    assert(fs.readFileSync(path.join(out,'changelog.md'),'utf8').includes(reason));
    const html=fs.readFileSync(path.join(out,'changelog/index.html'),'utf8');
    assert(html.includes('&lt;reviewed&gt; &amp; approved.'));assert(!html.includes('<reviewed>'));
    for(const invalid of ['', ' ', 3, 'line\nbreak', 'x'.repeat(1001)]) {
      entry.rows_justification=invalid;fs.writeFileSync(file,JSON.stringify({releases:[entry,previous]}));
      const result=publish();assert.equal(result.status,1);assert(result.stderr.includes('rows_justification'));
    }
  } finally {fs.rmSync(out,{recursive:true,force:true});}
});
