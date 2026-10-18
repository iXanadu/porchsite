/** Authenticated image_add: bounded preflight, then one atomic D1 batch. */
import { stripLocation } from "./image-privacy";
import { photoNext } from "./photo-advice";
import { ApiError } from "./errors";
import * as media from "./media";
import { invalidation } from "./public-artifacts";
import { reportUploadPhase } from "./upload-diagnostic";

const MAX_FILES = 8;
const MAX_TOTAL = 8 * 1024 * 1024;
// Hex keeps D1's binding wrapper from expanding every byte to a JS number.
// Decode in SQLite, retaining the existing BLOB storage/rollback format.
const CHUNK = media.CHUNK;
const NEXT = "Put image in an image field with a description, then ask for approval as usual.";

function compatiblePreflight(value: string): { raw: string; size: number } {
  const raw = value.replace(/^data:[^,]*,/, "").replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  const count = raw.length - padding;
  if (/[^A-Za-z0-9+/]/.test(raw.slice(0, count)) || count % 4 === 1 || (padding && raw.length % 4 !== 0)) {
    throw new ApiError(422, "invalid", "data isn't base64.");
  }
  return { raw, size: Math.floor(count * 3 / 4) };
}

// An upper bound when whitespace is present; exact for ordinary base64.
// Only the uncommon over-limit/error path needs normalization and a full scan.
function preflight(value: string): { raw: string; size: number } {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const raw = comma >= 0 ? value.slice(comma + 1) : value;
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  return { raw, size: Math.floor((raw.length - padding) * 3 / 4) };
}
function enforceLimits(files: {size: number}[]): void {
  if (files.some(f => f.size > media.MAX_BYTES)) throw new ApiError(413, "too_large", "A picture can be at most 8 MB.");
  if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) throw new ApiError(413, "too_large", "Pictures can total at most 8 MB.");
}
function decodeFiles(values: string[], files: {raw: string}[]): Uint8Array[] {
  try { return files.map(f => Uint8Array.fromBase64(f.raw)); }
  catch {
    // URL-safe/mixed alphabets and non-ASCII whitespace keep their old form.
    // Validate the entire batch first, preserving the original error priority.
    const compatible = values.map(compatiblePreflight);
    return compatible.map(f => Uint8Array.fromBase64(f.raw));
  }
}

export async function imageAdd(db: D1Database, actor: string, data?: string, images?: string[]) {
  if ((data !== undefined) === (images !== undefined)) throw new ApiError(422, "invalid", "Give exactly one of data or images.");
  const values = images ?? [data!];
  if (!values.length || values.length > MAX_FILES) throw new ApiError(422, "invalid", "Send 1 to 8 pictures.");
  // No byte decoding occurs until every encoded file's size has been checked.
  reportUploadPhase("preflight", "start");
  let files;
  try {
    files = values.map(preflight);
    if (files.some(f => f.size > media.MAX_BYTES) || files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) {
      files = values.map(compatiblePreflight);
      enforceLimits(files);
    }
  } finally { reportUploadPhase("preflight", "end"); }
  reportUploadPhase("decode", "start");
  let decoded;
  try { decoded = decodeFiles(values, files); }
  finally { reportUploadPhase("decode", "end"); }
  const sizes: number[] = [];
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  let backfill = false;
  const out: { image: string; width: number; height: number }[] = [];
  // Consume the validated buffers so processed files need not stay live.
  while (decoded.length) {
    let bytes = decoded.shift()!;
    reportUploadPhase("sniff", "start");
    let type: string | null;
    let width: number, height: number;
    try {
      type = media.sniff(bytes);
      if (!type) throw new ApiError(422, "not_an_image", "That isn't a JPEG, PNG or WebP picture.");
      bytes = stripLocation(bytes, type);
      sizes.push(bytes.length);
      [width, height] = media.size(bytes);
    } finally { reportUploadPhase("sniff", "end"); }
    reportUploadPhase("hash", "start");
    let hash: Uint8Array;
    try { hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); }
    finally { reportUploadPhase("hash", "end"); }
    const ext = type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : "webp";
    const name = `${hash.subarray(0, 16).toHex()}.${ext}`;
    out.push({ image: `/media/${name}`, width, height });
    if (seen.has(name)) continue;
    seen.add(name);
    const have = await db.prepare("SELECT width FROM media WHERE name = ?").bind(name).first<{ width: number }>();
    if (have) {
      if (!have.width && width) {
        backfill = true;
        stmts.push(db.prepare("UPDATE media SET width = ?, height = ? WHERE name = ? AND width = 0").bind(width, height, name));
      }
      continue;
    }
    reportUploadPhase("hex", "start");
    const chunks = Math.ceil(bytes.length / CHUNK);
    for (let n = 0; n < chunks; n++) {
      const chunk = bytes.subarray(n * CHUNK, (n + 1) * CHUNK);
      // Keep the existing writer's chunk boundaries. Split hex parameters to
      // stay below D1's per-value limit, concatenating decoded bytes in SQL.
      stmts.push(db.prepare("INSERT OR IGNORE INTO media_chunks (name, n, data) SELECT ?, ?, CAST(unhex(?) || unhex(?) AS BLOB) WHERE NOT EXISTS (SELECT 1 FROM media WHERE name = ?)").bind(name, n, chunk.subarray(0, 1_000_000).toHex(), chunk.subarray(1_000_000).toHex(), name));
    }
    reportUploadPhase("hex", "end");
    stmts.push(db.prepare("INSERT OR IGNORE INTO media (name, type, size, chunks, source, created_at, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(name, type, bytes.length, chunks, actor.slice(0, 500), new Date().toISOString(), width, height));
  }
  // No statement above has written anything. One batch commits or rolls back
  // all new chunks, media rows and metadata updates, without deleting by hash.
  if (stmts.length) {
    reportUploadPhase("d1", "start");
    try { await db.batch(backfill ? [...invalidation(db), ...stmts] : stmts); }
    finally { reportUploadPhase("d1", "end"); }
  }
  const next = photoNext(NEXT, sizes, images !== undefined);
  return images !== undefined ? { images: out, next } : { ...out[0], next };
}
