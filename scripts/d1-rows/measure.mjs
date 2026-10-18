import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CLOCK, ORIGIN, COMPATIBILITY, HEADERS, hash } from './fixtures.mjs';
import { FORMAT, BUDGETS, REQUESTS, validate } from './record.mjs';

export async function measure({ root, out, bundle, migrations, corpus, source, inputs, Miniflare, convertV4MiniflareOptions }) {
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(bundle, path.join(out, 'application.js'));
  for (const file of ['harness.mjs', 'observer.mjs']) fs.copyFileSync(path.join(root, 'scripts/d1-rows', file), path.join(out, file));
  fs.writeFileSync(path.join(out, 'clock.mjs'), `const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[${JSON.stringify(CLOCK)}]));}static now(){return ${Date.parse(CLOCK)};}};\n`);
  const record = { format: FORMAT, inputs_sha256: inputs, source_sha256: source, artifact_sha256: hash(fs.readFileSync(bundle)), budgets: BUDGETS, sites: corpus.map(site => site.name), cells: {} };
  for (const site of corpus) {
    const identity = new Map();
    for (const mode of ['off', 'on']) {
      const modules = ['harness.mjs','clock.mjs','observer.mjs','application.js'].map(file => ({type:'ESModule',path:path.join(out,file)}));
      const mf = new Miniflare(convertV4MiniflareOptions({ rootPath: out, modules, modulesRoot: out, ...COMPATIBILITY, d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'], bindings: { SITE_URL: ORIGIN, PUBLIC_ARTIFACTS: mode === 'on' ? '1' : '', PUBLIC_RESPONSES: '' }, outboundService: () => new Response(null, { status: 502 }) }));
      try {
        await mf.ready;
        const database = await mf.getD1Database('DB');
        for (const file of fs.readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) {
          const sql = fs.readFileSync(path.join(migrations, file), 'utf8').replace(/--[^\n]*/g, '');
          for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await database.prepare(statement).run();
        }
        await database.exec(site.sql);
        assert.equal(await database.prepare('SELECT count(*) n FROM public_artifacts').first('n'), 0, 'artifact seed must be empty');
        let etag;
        for (const kind of REQUESTS) {
          const response = await mf.dispatchFetch(ORIGIN + '/', { headers: { ...HEADERS, ...(kind === 'not_modified' ? { 'If-None-Match': etag } : {}) } });
          const value = await response.json();
          assert.equal(response.status, 200, 'measurement wrapper failed');
          assert.equal(value.status, kind === 'not_modified' ? 304 : 200, `${site.name}/${mode}/${kind} status`);
          const headers = Object.fromEntries(value.headers.map(([key, val]) => [key.toLowerCase(), val]));
          if (kind === 'not_modified') assert.equal(value.bytes, 0);
          else {
            assert.equal(headers['content-type'], 'text/html; charset=utf-8');
            assert.equal(headers['cache-control'], 'public, no-cache, must-revalidate, no-transform');
            assert(headers.etag, 'ETag required'); etag = headers.etag;
          }
          const counts = value.counters;
          assert(!counts.failed && counts.closed);
          if (mode === 'off') assert.equal(counts.artifact, 0, 'OFF touched artifacts');
          if (kind === 'plain' && mode === 'on') {
            assert(counts.hit > 0, 'plain ON is not a certified artifact HIT');
            assert.equal(counts.render, 0, 'HIT rendered live rows');
          }
          assert.equal(counts.traffic, kind === 'cold' ? 1 : 0, 'UC9 flush attribution changed');
          const publicHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => !['date', 'age', 'x-porchsite-release'].includes(name)));
          const proof = { status: value.status, bytes: value.bytes, digest: value.body_sha256, headers: publicHeaders };
          if (mode === 'off') identity.set(kind, proof);
          else assert.deepEqual(proof, identity.get(kind), 'OFF/ON response identity changed');
          record.cells[`${site.name}/${mode}/${kind}`] = { rows_read: counts.rows_read, rows_written: counts.rows_written };
        }
        // The cold request flushed one observed page. The repeat is buffered;
        // a 304 never counts. This audit is host-side, outside observer scope.
        assert.equal(await database.prepare('SELECT sum(requests) n FROM agent_traffic_daily').first('n'), 1, 'traffic storage changed');
      } finally { await mf.dispose(); }
    }
  }
  return validate(record);
}
