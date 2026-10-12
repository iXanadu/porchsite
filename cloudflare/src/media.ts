/**
 * Images (SPEC S7: no hotlinks). An image named by https URL in content is
 * fetched once when the item is saved, checked, stored in D1 by a hash of its
 * bytes, and the content is rewritten to /media/<name>. A published page then
 * never depends on someone else's host.
 *
 * D1 rather than R2: R2 has to be switched on in the Cloudflare dashboard
 * (with a card on file), which an assistant can't do for its person. D1 is
 * already there from the install.
 *
 * Fetching is safe to point at a caller's URL: https only, and the Worker's
 * global_fetch_strictly_public flag refuses private and internal addresses.
 */
import { ApiError } from "./errors";
import type { Kind } from "./models";

export const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK = 1_900_000; // under D1's 2 MB row limit
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const TYPE: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Image fields per kind, each with the field that must describe it. */
export const IMAGE_FIELDS: Partial<Record<Kind, [string, string][]>> = {
  site: [["hero", "hero_alt"], ["logo", "logo_alt"], ["follow_image", "follow_image_alt"], ["share_image", "share_image_alt"]],
  entry: [["cover", "cover_alt"]],
  card: [["image", "image_alt"]],
};
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
export const LOCAL = /^\/media\/([0-9a-f]{32}\.(?:jpg|png|webp))$/;

export type Fetcher = (url: string) => Promise<Response>;

export function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  const ascii = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}

function failed(field: string, url: string, why: string): ApiError {
  return new ApiError(422, "image_failed", `Couldn't use the image in ${field} (${url}): ${why}.`, { field, image_url: url });
}

async function download(url: string, field: string, fetcher: Fetcher): Promise<{ bytes: Uint8Array; type: string }> {
  if (!/^https:\/\/[^\s]+$/.test(url)) throw failed(field, url, "it must be a full https:// link to the image");
  let res: Response;
  try {
    res = await fetcher(url);
  } catch {
    throw failed(field, url, "that address didn't answer (it must be public)");
  }
  if (!res.ok) throw failed(field, url, `the server answered ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw failed(field, url, `it is over ${MAX_BYTES / 1024 / 1024} MB; send a smaller copy`);
  const reader = res.body?.getReader();
  if (!reader) throw failed(field, url, "it came back empty");
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw failed(field, url, `it is over ${MAX_BYTES / 1024 / 1024} MB; send a smaller copy`);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  const type = sniff(bytes);
  if (!type) throw failed(field, url, "it isn't a JPEG, PNG or WebP image");
  return { bytes, type };
}

/** Pixel size from a JPEG, PNG or WebP header; [0, 0] if it can't tell. */
export function size(b: Uint8Array): [number, number] {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const type = sniff(b);
  if (type === "image/png" && b.length >= 24) return [u32(16), u32(20)];
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return [0, 0];
      const marker = b[i + 1];
      // Start-of-frame markers carry the size; skip everything else.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [u16(i + 7), u16(i + 5)];
      i += 2 + u16(i + 2);
    }
    return [0, 0];
  }
  if (type === "image/webp" && b.length >= 30) {
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === "VP8 ") return [le16(26) & 0x3fff, le16(28) & 0x3fff];
    if (chunk === "VP8L") return [1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6))];
    if (chunk === "VP8X") return [1 + le24(24), 1 + le24(27)];
  }
  return [0, 0];
}

/** Store bytes once, by hash; returns the /media path. */
export async function store(db: D1Database, bytes: Uint8Array, type: string, source: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const name = `${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}.${EXT[type]}`;
  const have = await db.prepare("SELECT width FROM media WHERE name = ?").bind(name).first<{ width: number }>();
  if (have && !have.width) {
    // Stored before sizes were recorded: fill it in now.
    const [w, h] = size(bytes);
    if (w) await db.prepare("UPDATE media SET width = ?, height = ? WHERE name = ?").bind(w, h, name).run();
  }
  if (!have) {
    const chunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK));
    const stmts = [];
    for (let n = 0; n < chunks; n++) {
      stmts.push(db.prepare("INSERT OR REPLACE INTO media_chunks (name, n, data) VALUES (?, ?, ?)").bind(name, n, bytes.slice(n * CHUNK, (n + 1) * CHUNK)));
    }
    // The media row goes last, so a half-written image is never served.
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO media (name, type, size, chunks, source, created_at, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(name, type, bytes.byteLength, chunks, source.slice(0, 500), new Date().toISOString(), ...size(bytes)),
    );
    await db.batch(stmts);
  }
  return `/media/${name}`;
}

async function localPath(db: D1Database, field: string, url: string, fetcher: Fetcher): Promise<string> {
  const local = LOCAL.exec(url);
  if (local) {
    if (!(await db.prepare("SELECT name FROM media WHERE name = ?").bind(local[1]).first())) {
      throw failed(field, url, "this site has no image by that name");
    }
    return url;
  }
  const { bytes, type } = await download(url, field, fetcher);
  return store(db, bytes, type, url);
}

/**
 * Copy every image an item names into the site, and require a description
 * for each. Returns the data with image fields pointing at /media.
 */
export async function localize(
  db: D1Database,
  kind: Kind,
  data: Record<string, unknown>,
  fetcher: Fetcher = (u) => fetch(u, { headers: { Accept: "image/*" } }),
): Promise<Record<string, unknown>> {
  const out = { ...data };
  const problems: { field: string; problem: string }[] = [];
  for (const [field, alt] of IMAGE_FIELDS[kind] ?? []) {
    const url = String(out[field] ?? "");
    if (!url) continue;
    if (!String(out[alt] ?? "").trim()) {
      problems.push({ field: alt, problem: `describe the image in ${field} in a few words, for people who can't see it` });
      continue;
    }
    out[field] = await localPath(db, field, url, fetcher);
  }
  if (kind === "entry" && typeof out.body === "string") {
    let body = out.body;
    for (const m of [...body.matchAll(MD_IMAGE)]) {
      const [whole, altText, url] = m;
      if (!altText.trim()) {
        problems.push({ field: "body", problem: `the image ${url} needs a description: ![what it shows](${url})` });
        continue;
      }
      const path = await localPath(db, "body", url, fetcher);
      if (path !== url) body = body.replace(whole, `![${altText}](${path})`);
    }
    out.body = body;
  }
  if (problems.length) {
    throw new ApiError(422, "invalid", "The content doesn't validate. Fix the listed fields and resend.", { problems });
  }
  return out;
}

/** Whether a published item uses this image: only then may anyone see it (S1). */
export async function published(db: D1Database, name: string): Promise<boolean> {
  if (await db.prepare("SELECT 1 FROM live WHERE instr(data, ?) > 0 LIMIT 1").bind(`/media/${name}`).first()) return true;
  // A published entry's share card is public too.
  return !!(await db.prepare("SELECT 1 FROM share_cards s JOIN live l ON l.item_id = s.item_id WHERE s.name = ? LIMIT 1").bind(name).first());
}

async function bytesOf(db: D1Database, name: string): Promise<Uint8Array> {
  const { results } = await db.prepare("SELECT data FROM media_chunks WHERE name = ? ORDER BY n").bind(name).all<{ data: ArrayBuffer | number[] }>();
  const parts = results.map((r) => new Uint8Array(r.data as ArrayBuffer));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** An image's pixel size, measured now if it was stored before sizes were kept. */
export async function sizeOf(db: D1Database, name: string): Promise<[number, number]> {
  const r = await db.prepare("SELECT width, height FROM media WHERE name = ?").bind(name).first<{ width: number; height: number }>();
  if (!r) return [0, 0];
  if (r.width) return [r.width, r.height];
  const [w, h] = size(await bytesOf(db, name));
  if (w) await db.prepare("UPDATE media SET width = ?, height = ? WHERE name = ?").bind(w, h, name).run();
  return [w, h];
}

/**
 * GET /media/<name>: the stored bytes. A published image is cached for good
 * (the name is the content); one only the owner may see yet is never cached.
 */
export async function serve(db: D1Database, name: string, isPublic: boolean): Promise<Response | null> {
  const row = await db.prepare("SELECT type, chunks FROM media WHERE name = ?").bind(name).first<{ type: string; chunks: number }>();
  if (!row) return null;
  const { results } = await db.prepare("SELECT data FROM media_chunks WHERE name = ? ORDER BY n").bind(name).all<{ data: ArrayBuffer | number[] }>();
  const body = new Blob(results.map((r) => (Array.isArray(r.data) ? new Uint8Array(r.data) : new Uint8Array(r.data))), { type: row.type });
  return new Response(body, {
    headers: {
      "Content-Type": TYPE[name.split(".").pop() ?? ""] ?? row.type,
      "Cache-Control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
