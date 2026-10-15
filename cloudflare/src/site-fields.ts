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
export function brokerWrite(db: D1Database, version: number, data: Record<string,unknown>): D1PreparedStatement {
  return db.prepare("INSERT INTO site_fields (version, key, value) SELECT version, 'broker', ? FROM items WHERE id = 'site' AND version = ? AND changes() = 1 AND ? <> ''")
    .bind(JSON.stringify(data.broker ?? ""), version, String(data.broker ?? ""));
}
export function fieldsApproval(db: D1Database, version: number): D1PreparedStatement {
  return db.prepare("UPDATE site_fields SET approved = 1 WHERE version = ? AND EXISTS (SELECT 1 FROM live WHERE item_id = 'site' AND version = ?)").bind(version, version);
}
