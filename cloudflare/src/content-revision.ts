import * as publicRead from './public-read';
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

/** Disjoint from every dependency category; never passed to dependency decode. */
export const WITNESS_CATEGORY='__content_revision_witness__';
export const INITIAL_SQL=`WITH dependency_facts AS (${publicRead.FACTS_SQL})
SELECT category,ident,value FROM (SELECT category,ident,value FROM dependency_facts
UNION ALL SELECT '${WITNESS_CATEGORY}','epoch-counter-v1',json_array(epoch,typeof(epoch),CAST(n AS TEXT),typeof(n)) FROM content_revision WHERE id=1) AS transport_rows ORDER BY category,ident`;
export function initialSnapshot(rows:publicRead.Row[]):{facts:publicRead.Facts;pair:string|null} {
 const state=rows.filter(r=>r.category===WITNESS_CATEGORY),dependencies=rows.filter(r=>r.category!==WITNESS_CATEGORY);
 let pair:string|null=null;
 try {
  const value=state.length===1&&state[0].ident==='epoch-counter-v1'?JSON.parse(state[0].value):null;
  if(Array.isArray(value)&&value.length===4&&value[1]==='text'&&value[3]==='integer'&&canonicalEpoch(value[0])&&canonicalCounter(value[2]))pair=JSON.stringify([value[0],value[2]]);
 } catch {/* Invalid metadata cannot supply a witness. Complete facts still decode. */}
 const raw=dependencies.map(r=>[r.category,r.ident,r.value]);
 return {facts:{...publicRead.decode(dependencies),raw},pair};
}
export async function initialFacts(db:D1Database):Promise<{facts:publicRead.Facts;pair:string|null}> {
 let rows:publicRead.Row[];
 try { rows=(await db.prepare(INITIAL_SQL).all<publicRead.Row>()).results; }
 catch(error) {
  // Only a known absent optional table permits a fresh plain-query fallback.
  const message=error instanceof Error?error.message:'';
  if(!/no such table: (?:main\.)?content_revision(?:\b|$)/i.test(message))throw error;
  return {facts:await publicRead.facts(db),pair:null};
 }
 return initialSnapshot(rows);
}
