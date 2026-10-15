/** Authenticated image_add: bounded preflight, then one atomic D1 batch. */
import { ApiError } from "./errors";
import * as media from "./media";

const MAX_FILES = 8;
const MAX_TOTAL = 8 * 1024 * 1024;
// Hex keeps D1's binding wrapper from expanding every byte to a JS number.
// Decode in SQLite, retaining the existing BLOB storage/rollback format.
const CHUNK = media.CHUNK;
const NEXT = "Put image in an image field with a description, then ask for approval as usual.";

function preflight(value: string): { raw: string; size: number } {
  const raw = value.replace(/^data:[^,]*,/, "").replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  const count = raw.length - padding;
  if (/[^A-Za-z0-9+/]/.test(raw.slice(0, count)) || count % 4 === 1 || (padding && raw.length % 4 !== 0)) {
    throw new ApiError(422, "invalid", "data isn't base64.");
  }
  return { raw, size: Math.floor(count * 3 / 4) };
}

export async function imageAdd(db: D1Database, actor: string, data?: string, images?: string[]) {
  if ((data !== undefined) === (images !== undefined)) throw new ApiError(422, "invalid", "Give exactly one of data or images.");
  const values = images ?? [data!];
  if (!values.length || values.length > MAX_FILES) throw new ApiError(422, "invalid", "Send 1 to 8 pictures.");
  // No byte decoding occurs until every encoded file's size has been checked.
  const files = values.map(preflight);
  if (files.some((f) => f.size > media.MAX_BYTES)) throw new ApiError(413, "too_large", "A picture can be at most 8 MB.");
  if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) throw new ApiError(413, "too_large", "Pictures can total at most 8 MB.");
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  const out: { image: string; width: number; height: number }[] = [];
  for (const f of files) {
    const bytes = Uint8Array.fromBase64(f.raw);
    const type = media.sniff(bytes);
    if (!type) throw new ApiError(422, "not_an_image", "That isn't a JPEG, PNG or WebP picture.");
    const [width, height] = media.size(bytes);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const ext = type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : "webp";
    const name = `${hash.subarray(0, 16).toHex()}.${ext}`;
    out.push({ image: `/media/${name}`, width, height });
    if (seen.has(name)) continue;
    seen.add(name);
    const have = await db.prepare("SELECT width FROM media WHERE name = ?").bind(name).first<{ width: number }>();
    if (have) {
      if (!have.width && width) stmts.push(db.prepare("UPDATE media SET width = ?, height = ? WHERE name = ? AND width = 0").bind(width, height, name));
      continue;
    }
    const chunks = Math.ceil(bytes.length / CHUNK);
    for (let n = 0; n < chunks; n++) {
      const chunk = bytes.subarray(n * CHUNK, (n + 1) * CHUNK);
      // Keep the existing writer's chunk boundaries. Split hex parameters to
      // stay below D1's per-value limit, concatenating decoded bytes in SQL.
      stmts.push(db.prepare("INSERT OR IGNORE INTO media_chunks (name, n, data) SELECT ?, ?, CAST(unhex(?) || unhex(?) AS BLOB) WHERE NOT EXISTS (SELECT 1 FROM media WHERE name = ?)").bind(name, n, chunk.subarray(0, 1_000_000).toHex(), chunk.subarray(1_000_000).toHex(), name));
    }
    stmts.push(db.prepare("INSERT OR IGNORE INTO media (name, type, size, chunks, source, created_at, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(name, type, bytes.length, chunks, actor.slice(0, 500), new Date().toISOString(), width, height));
  }
  // No statement above has written anything. One batch commits or rolls back
  // all new chunks, media rows and metadata updates, without deleting by hash.
  if (stmts.length) await db.batch(stmts);
  return images !== undefined ? { images: out, next: NEXT } : { ...out[0], next: NEXT };
}
