/** Request-local (epoch,counter) equality; never an outward tag or authority grant. */
export const REVISION_SQL = "SELECT epoch, typeof(epoch) AS epoch_storage, CAST(n AS TEXT) AS n, typeof(n) AS storage FROM content_revision WHERE id = 1";
const MAX = '9223372036854775807';
export function canonicalCounter(value:unknown):value is string {
 return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && (value.length < MAX.length || value <= MAX);
}
export function canonicalEpoch(value:unknown):value is string { return typeof value==='string' && /^[0-9a-f]{32}$/.test(value); }
export async function readRevision(db:D1Database):Promise<string|null> {
 try {
  const rows=(await db.prepare(REVISION_SQL).all<{epoch:unknown;epoch_storage:unknown;n:unknown;storage:unknown}>()).results;
  if(rows.length!==1)return null;
  const row=rows[0];
  return row.storage==='integer' && row.epoch_storage==='text' && canonicalEpoch(row.epoch) && canonicalCounter(row.n) ? JSON.stringify([row.epoch,row.n]) : null;
 } catch { return null; }
}
