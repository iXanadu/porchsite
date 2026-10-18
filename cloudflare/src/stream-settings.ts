/** Complete logical settings beside an old-readable site JSON projection. */
import { SiteData } from './models';
import { ApiError } from './errors';
type Data = Record<string, any>;
export const schema = SiteData.pick({streams: true, sections: true, archive: true}).strict();
export function streamProjection(data: Data): Data {
  const {archive, ...legacy} = data;
  if (!Array.isArray(data.streams)) return legacy;
  const kept = data.streams.slice(0, 8).map(({sort, ...stream}: Data) => stream);
  const ids = new Set(kept.map((s: Data) => s.id));
  return {...legacy, streams: kept, ...(Array.isArray(data.sections) ? {sections: data.sections.filter((s: string) => ['entries','cards','notes','about'].includes(s) || ids.has(s)).slice(0,12)} : {})};
}
export function checkStreamSettings(data: Data): void {
  const paths = data.streams.map((s: Data) => s.path || s.id);
  if (new Set(paths).size !== paths.length) throw new ApiError(422, 'invalid', 'Each stream path must be unique.');
  if (data.archive.enabled && data.streams.some((s: Data) => s.id === 'archive' || (s.path || s.id) === 'archive')) throw new ApiError(422, 'invalid', 'The combined archive needs /archive/; change the conflicting stream id or path first.');
}
export async function streamData(db: D1Database, version: number, live: boolean): Promise<Data> {
  let row: {settings: string; approved: number} | null;
  try { row = await db.prepare('SELECT settings, approved FROM site_stream_settings WHERE version = ?').bind(version).first(); }
  catch (e) { if (String(e).includes('no such table: site_stream_settings')) return {}; throw e; }
  if (!row || (live && !row.approved)) return {};
  try { return schema.parse(JSON.parse(row.settings)); }
  catch { throw new ApiError(422, 'invalid', 'Stored stream settings do not validate.'); }
}
export function streamWrite(db: D1Database, version: number, data: Data): D1PreparedStatement {
  const settings = schema.parse({streams:data.streams, sections:data.sections, archive:data.archive});
  checkStreamSettings(settings);
  return db.prepare(`INSERT INTO site_stream_settings (version, settings)
    SELECT version, ? FROM items WHERE id = 'site' AND version = ? AND changes() = 1
    ON CONFLICT(version) DO UPDATE SET settings = excluded.settings, approved = 0`)
    .bind(JSON.stringify(settings), version);
}
export function streamApproval(db: D1Database, version: number): D1PreparedStatement {
  return db.prepare("UPDATE site_stream_settings SET approved = 1 WHERE version = ? AND EXISTS (SELECT 1 FROM live WHERE item_id = 'site' AND version = ?)").bind(version,version);
}
