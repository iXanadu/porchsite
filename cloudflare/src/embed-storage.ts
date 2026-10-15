/** Versioned site extension. Legacy item JSON stays readable on rollback. */
import { embedSources } from "./embed-url";
import { ApiError } from "./errors";
type Data = Record<string, unknown>;

export function storedData(kind: string, data: Data): Data {
  if (kind !== "site") return data;
  const { embed_sources, ...legacy } = data;
  return legacy;
}

export async function sourceData(db: D1Database, id: string, version: number, data: Data, live = false): Promise<Data> {
  if (id !== "site") return data;
  let row: { sources: string; approved: number } | null;
  try { row = await db.prepare("SELECT sources, approved FROM site_embed_sources WHERE version = ?").bind(version).first<{ sources: string; approved: number }>(); }
  catch (error) {
    if (!String(error).includes("no such table: site_embed_sources")) throw error;
    return { ...data, embed_sources: [] };
  }
  return { ...data, embed_sources: row ? (live && !row.approved ? [] : JSON.parse(row.sources)) : data.embed_sources ?? [] };
}

export function sourceWrite(db: D1Database, version: number, data: Data): D1PreparedStatement {
  return db.prepare("INSERT INTO site_embed_sources (version, sources) SELECT version, ? FROM items WHERE id = 'site' AND version = ? AND changes() = 1")
    .bind(JSON.stringify(data.embed_sources ?? []), version);
}

export function sourceApproval(db: D1Database, version: number): D1PreparedStatement {
  return db.prepare("UPDATE site_embed_sources SET approved = 1 WHERE version = ? AND EXISTS (SELECT 1 FROM live WHERE item_id = 'site' AND version = ?)").bind(version, version);
}

/** Repair only representation, never versions or the staged/live boundary. */
export async function migrateSources(db: D1Database): Promise<void> {
  const { results } = await db.prepare(`SELECT version, data, 0 AS approved FROM items WHERE id = 'site' AND json_type(data, '$.embed_sources') IS NOT NULL
    UNION ALL SELECT version, data, 0 FROM revisions WHERE item_id = 'site' AND json_type(data, '$.embed_sources') IS NOT NULL
    UNION ALL SELECT version, data, 1 FROM live WHERE item_id = 'site' AND json_type(data, '$.embed_sources') IS NOT NULL`).all<{ version: number; data: string; approved: number }>();
  if (!results.length) return;
  const versions = new Map<number, { sources: string; approved: number }>();
  for (const row of results) {
    const sources = JSON.stringify(embedSources(JSON.parse(row.data).embed_sources));
    const old = versions.get(row.version) ?? await db.prepare("SELECT sources, approved FROM site_embed_sources WHERE version = ?").bind(row.version).first<{ sources: string; approved: number }>();
    if (old && old.sources !== sources) throw new ApiError(409, "source_conflict", "Stored embed sources disagree for one site version.");
    versions.set(row.version, { sources, approved: Math.max(old?.approved ?? 0, row.approved) });
  }
  const statements: D1PreparedStatement[] = [];
  for (const [version, row] of versions) {
    statements.push(db.prepare("INSERT OR IGNORE INTO site_embed_sources (version, sources, approved) VALUES (?, ?, ?)").bind(version, row.sources, row.approved));
    if (row.approved) statements.push(sourceApproval(db, version));
  }
  statements.push(
    db.prepare("UPDATE items SET data = json_remove(data, '$.embed_sources') WHERE id = 'site' AND json_type(data, '$.embed_sources') IS NOT NULL"),
    db.prepare("UPDATE revisions SET data = json_remove(data, '$.embed_sources') WHERE item_id = 'site' AND json_type(data, '$.embed_sources') IS NOT NULL"),
    db.prepare("UPDATE live SET data = json_remove(data, '$.embed_sources') WHERE item_id = 'site' AND json_type(data, '$.embed_sources') IS NOT NULL"),
  );
  await db.batch(statements);
}
