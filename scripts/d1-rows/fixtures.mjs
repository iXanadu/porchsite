import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
// Keep the application clock reproducible and ahead of SQLite's host clock:
// SQLite's julianday('now') admission guard must remain unchanged. This is a
// row-count fixture clock, not a claim about today's rendered event selection.
export const CLOCK = '2030-01-01T12:00:00.000Z';
export const ORIGIN = 'https://site.example';
export const COMPATIBILITY = { compatibilityDate: '2026-08-15', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'] };
export const HEADERS = { Accept: 'text/html', 'User-Agent': 'PorchsiteRowsGate/1' };
const stamp = '2026-10-10T12:00:00.000Z';
const quote = value => value === null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
export async function fixtures(root, esbuild, out) {
  const modelFile = path.join(out, 'models.mjs');
  await esbuild.build({ stdin: { contents: 'export {validate} from "./src/content"; export {PREFIX} from "./src/models";', resolveDir: path.join(root, 'cloudflare') }, bundle: true, platform: 'node', format: 'esm', outfile: modelFile, logLevel: 'silent' });
  const { validate, PREFIX } = await import('file://' + modelFile);
  const samples = fs.readdirSync(path.join(root, 'themes')).sort().filter(name => fs.existsSync(path.join(root, 'themes', name, 'sample.json')));
  if (samples.length !== 12) throw Error('Corpus changed: explicit baseline rebase required');
  return [...samples.map(name => [name, false]), ['services-page', true]].map(([look, large]) => {
    const sample = JSON.parse(fs.readFileSync(path.join(root, 'themes', look, 'sample.json'), 'utf8'));
    if (large) {
      const template = sample.items.find(item => item.kind === 'entry').data;
      sample.items = [...sample.items.filter(item => item.kind !== 'entry'), ...Array.from({ length: 200 }, (_, i) => ({ kind: 'entry', slug: 'bulk-' + i, data: { ...template, title: 'Entry ' + String(i).padStart(4, '0'), stream: sample.site.streams[i % sample.site.streams.length].id, external_url: '', body: template.body + '\n\nSynthetic fixture entry ' + i } }))];
    }
    const rows = [{ id: 'site', kind: 'site', slug: null, data: validate('site', { ...sample.site, theme: look }) }, ...sample.items.map((item, i) => ({ id: PREFIX[item.kind] + '_' + i.toString(16).padStart(8, '0'), kind: item.kind, slug: item.kind === 'entry' ? item.slug ?? 'item-' + i : null, data: validate(item.kind, item.data) }))];
    const lines = rows.flatMap(row => {
      const data = JSON.stringify(row.data);
      return [
        `INSERT INTO items(id,kind,slug,version,data,deleted,created_at,updated_at) VALUES(${[row.id,row.kind,row.slug,1,data,0,stamp,stamp].map(quote)});`,
        `INSERT INTO live(item_id,kind,slug,version,data,published_at) VALUES(${[row.id,row.kind,row.slug,1,data,stamp].map(quote)});`,
        `INSERT INTO revisions(item_id,version,action,data,deleted,actor,reason,created_at) VALUES(${[row.id,1,'create',data,0,'owner','Synthetic fixture',stamp].map(quote)});`,
      ];
    });
    const site = rows[0].data;
    lines.push(`INSERT INTO site_stream_settings(version,settings,approved) VALUES(1,${quote(JSON.stringify({streams:site.streams,sections:site.sections,archive:site.archive}))},1);`);
    lines.push(`INSERT INTO site_embed_sources(version,sources,approved) VALUES(1,${quote(JSON.stringify(site.embed_sources ?? []))},1);`);
    lines.push(`INSERT INTO owner(id,name,user_handle,created_at) VALUES(1,'Owner','fixture',${quote(stamp)});`);
    const sql = lines.join('\n');
    return { name: look + (large ? '-200' : ''), sql, sha256: hash(sql) };
  });
}
