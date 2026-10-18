import assert from 'node:assert/strict';
export const FORMAT = 1;
export const BUDGETS = { rows_read: 5_000_000, rows_written: 100_000, verified: '2026-10-18', source: 'https://developers.cloudflare.com/d1/platform/pricing/' };
export const REQUESTS = ['cold', 'plain', 'not_modified'];
export function validate(record) {
  assert.equal(record.format, FORMAT, 'row record format');
  assert.match(record.inputs_sha256, /^[a-f0-9]{64}$/);
  assert.match(record.artifact_sha256, /^[a-f0-9]{64}$/);
  assert.match(record.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(record.cells).length, 78, 'complete 13-site matrix required');
  assert.equal(record.sites.length, 13);
  assert.equal(new Set(record.sites).size, 13);
  for (const site of record.sites) for (const mode of ['off', 'on']) for (const request of REQUESTS) {
    const value = record.cells[`${site}/${mode}/${request}`];
    assert(value, 'missing row cell');
    assert.deepEqual(Object.keys(value).sort(), ['rows_read', 'rows_written']);
    for (const metric of ['rows_read', 'rows_written']) assert(Number.isSafeInteger(value[metric]) && value[metric] >= 0, 'invalid row total');
  }
  return record;
}
export function compare(current, previous, justification) {
  validate(current); validate(previous);
  assert.equal(current.inputs_sha256, previous.inputs_sha256, 'baseline inputs changed: rebase explicitly');
  assert.deepEqual(current.sites, previous.sites, 'baseline corpus changed');
  if (justification !== undefined) assert(typeof justification === 'string' && justification.trim() && justification.length <= 1000 && !/[\r\n]/.test(justification), 'invalid rows_justification');
  const increases = [];
  for (const [key, value] of Object.entries(current.cells)) for (const metric of ['rows_read', 'rows_written']) {
    if (value[metric] > previous.cells[key][metric]) increases.push({ cell: key, metric, before: previous.cells[key][metric], after: value[metric] });
  }
  if (increases.length && !justification) throw Error(`D1 rows increased in ${increases.length} cell metrics; rows_justification required`);
  return increases;
}
export function capacity(value) {
  const reads = value.rows_read ? Math.floor(BUDGETS.rows_read / value.rows_read) : null;
  const writes = value.rows_written ? Math.floor(BUDGETS.rows_written / value.rows_written) : null;
  return { reads, writes, combined: reads === null ? writes : writes === null ? reads : Math.min(reads, writes) };
}
export function printComparison(current, previous, justification, print = console.log) {
  for (const key of Object.keys(current.cells).sort()) {
    const before = previous.cells[key], after = current.cells[key], a = capacity(before), b = capacity(after);
    const show = n => n === null ? 'unlimited by this metric' : n.toLocaleString('en-US');
    print(`${key}: reads ${before.rows_read} -> ${after.rows_read}; writes ${before.rows_written} -> ${after.rows_written}; read-limit ${show(a.reads)} -> ${show(b.reads)}, write-limit ${show(a.writes)} -> ${show(b.writes)}; about ${show(b.combined)} page views a day per account, if all requests cost this much and no other activity uses D1${key.endsWith('/not_modified') ? ' (304 request equivalents, not analytics views)' : ''}`);
  }
  for (const site of current.sites) for (const mode of ['off', 'on']) {
    const sum = record => REQUESTS.reduce((v, name) => {
      const cell = record.cells[`${site}/${mode}/${name}`];
      return { rows_read: v.rows_read + cell.rows_read, rows_written: v.rows_written + cell.rows_written };
    }, { rows_read: 0, rows_written: 0 });
    print(`${site}/${mode} three-request sequence: ${JSON.stringify(sum(previous))} -> ${JSON.stringify(sum(current))}`);
  }
  if (justification) print(`rows_justification: ${justification}`);
  print('Local D1-only illustrative upper bounds; other account activity, Workers limits and storage reduce usable traffic. Owner approval is required before deploying an increase.');
}
