/**
 * Assistant keys (SPEC §4): a bearer token the owner makes on
 * /review/assistants for an assistant whose app can't add a connector with
 * sign-in. Sent to /mcp as "Authorization: Bearer psk_…", it reaches the same
 * tools as a connected assistant: drafting only, everything waits for the
 * owner. Only its SHA-256 is kept; it expires after KEY_DAYS and can be
 * revoked. Port-matched: server/server/app/keys.py.
 */
export const PREFIX = "psk_";
export const KEY_DAYS = 90;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const hashOf = async (token: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface Key {
  id: string;
  name: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

/** A new key: the token is returned once and never stored. */
export async function create(db: D1Database, name: string): Promise<{ id: string; token: string; expires_at: string }> {
  const token = PREFIX + b64url(crypto.getRandomValues(new Uint8Array(24)));
  const id = `key_${hex(crypto.getRandomValues(new Uint8Array(6)).buffer)}`;
  const now = new Date();
  const expires_at = new Date(now.getTime() + KEY_DAYS * 86400_000).toISOString();
  await db
    .prepare("INSERT INTO assistant_keys (id, name, key_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, name, await hashOf(token), now.toISOString(), expires_at)
    .run();
  return { id, token, expires_at };
}

/** Keys that still work, newest first. */
export async function list(db: D1Database): Promise<Key[]> {
  const { results } = await db
    .prepare("SELECT id, name, created_at, expires_at, last_used_at FROM assistant_keys WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
    .bind(new Date().toISOString())
    .all<Key>();
  return results;
}

export async function revoke(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE assistant_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(new Date().toISOString(), id).run();
}

/** The assistant a key stands for, or null when it's unknown, revoked or expired. */
export async function lookup(db: D1Database, token: string, observe=true): Promise<{ client: string; clientId: string } | null> {
  if (!token.startsWith(PREFIX)) return null;
  const now = new Date().toISOString();
  const row = await db
    .prepare("SELECT id, name FROM assistant_keys WHERE key_hash = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(await hashOf(token), now)
    .first<{ id: string; name: string }>();
  if (!row) return null;
  if(observe)await db.prepare("UPDATE assistant_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  return { client: row.name, clientId: `key:${row.id}` };
}
