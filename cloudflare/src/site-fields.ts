/** Exact-version logical fields; old bundles never read this table. */
export async function brokerData(db: D1Database, version: number, live: boolean): Promise<string> {
  try {
    const row = await db.prepare("SELECT value, approved FROM site_fields WHERE version = ? AND key = 'broker'").bind(version).first<{value:string;approved:number}>();
    return row && (!live || row.approved) ? JSON.parse(row.value) : "";
  } catch (error) {
    if (String(error).includes("no such table: site_fields")) return "";
    throw error;
  }
}
export async function privateData(db: D1Database, version: number, live: boolean): Promise<boolean> {
  const row = await db.prepare("SELECT value,approved FROM site_fields WHERE version = ? AND key = 'private'").bind(version).first<any>();
  return !!row && JSON.parse(row.value) === true && (!live || (!!row.approved && !!await db.prepare("SELECT 1 FROM private_approvals WHERE version = ?").bind(version).first()));
}
export function brokerWrite(db: D1Database, version: number, data: Record<string,unknown>): D1PreparedStatement {
  // One statement retains the successful version-write precondition for every extension field.
  return db.prepare(`INSERT INTO site_fields (version,key,value)
    SELECT i.version,f.key,f.value FROM items i CROSS JOIN
    (SELECT 'broker' AS key, ? AS value UNION ALL SELECT 'private', ? UNION ALL SELECT 'ai_training_disabled', ?) f
    WHERE i.id = 'site' AND i.version = ? AND changes() = 1
    AND ((f.key = 'broker' AND f.value <> '\"\"') OR (f.key IN ('private','ai_training_disabled') AND f.value = 'true'))`)
    .bind(JSON.stringify(data.broker ?? ""), JSON.stringify(data.private === true), JSON.stringify(data.ai_training_disabled === true), version);
}
export function fieldsApproval(db: D1Database, version: number): D1PreparedStatement {
  return db.prepare("UPDATE site_fields SET approved = 1 WHERE version = ? AND EXISTS (SELECT 1 FROM live WHERE item_id = 'site' AND version = ?)").bind(version, version);
}

/** Previous releases approve every site_fields key; only this receipt proves a new-code approval. */
export function privateApproval(db: D1Database,version: number): D1PreparedStatement {
  return db.prepare("INSERT OR IGNORE INTO private_approvals (version) SELECT f.version FROM site_fields f JOIN live l ON l.version = f.version AND l.item_id = 'site' WHERE f.version = ? AND f.key = 'private' AND f.approved = 1").bind(version);
}

export async function trainingData(db: D1Database, version: number, live: boolean): Promise<boolean> {
  const row = await db.prepare("SELECT value,approved FROM site_fields WHERE version = ? AND key = 'ai_training_disabled'").bind(version).first<{value:string;approved:number}>();
  return !!row && JSON.parse(row.value) === true && (!live || (!!row.approved && !!await db.prepare("SELECT 1 FROM training_approvals a JOIN live l ON l.version = a.version AND l.item_id = 'site' WHERE a.version = ?").bind(version).first()));
}

/** Never backfill this receipt from an old runtime's bulk-approved fields. */
export function trainingApproval(db: D1Database, version: number): D1PreparedStatement {
  return db.prepare("INSERT OR IGNORE INTO training_approvals (version) SELECT f.version FROM site_fields f JOIN live l ON l.version = f.version AND l.item_id = 'site' WHERE f.version = ? AND f.key = 'ai_training_disabled' AND f.value = 'true' AND f.approved = 1").bind(version);
}

export const TRAINING_NOTE = "AI training is currently allowed. Training-off is proposed; publish a fresh site version with this choice to activate it.";
/** Protected owner/assistant state only; never part of published site data. */
export async function trainingState(db: D1Database) {
  const current = await db.prepare("SELECT version FROM items WHERE id = 'site' AND deleted = 0").first<{version:number}>();
  const live = await db.prepare("SELECT version FROM live WHERE item_id = 'site'").first<{version:number}>();
  const proposed = !!current && await trainingData(db, current.version, false);
  const effective = !!live && await trainingData(db, live.version, true);
  return { proposed_disabled: proposed, effective_disabled: effective, needs_publication: proposed && !effective,
    note: proposed && !effective ? TRAINING_NOTE : "" };
}
