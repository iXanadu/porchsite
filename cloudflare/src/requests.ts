/**
 * Asking the Porchsite community for a theme that doesn't exist yet. The
 * request goes privately to a queue (src/home.ts), sent from this
 * site's own server; the queue checks it came from here by fetching a
 * one-time proof (/.well-known/sitekeeper-proof/<nonce>). A curator groups
 * requests; this site can see whether its requests were answered.
 */
import { ApiError } from "./errors";
import { HOME } from "./home";

export const QUEUE = HOME;
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const PROOF_MINUTES = 5;

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function newProof(db: D1Database): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const cutoff = new Date(Date.now() - PROOF_MINUTES * 60_000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM request_proofs WHERE created_at < ?").bind(cutoff),
    db.prepare("INSERT INTO request_proofs (nonce, created_at) VALUES (?, ?)").bind(nonce, new Date().toISOString()),
  ]);
  return nonce;
}

/** The queue asking "did you send this?": yes once, for a few minutes. */
export async function answerProof(db: D1Database, nonce: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - PROOF_MINUTES * 60_000).toISOString();
  const row = await db.prepare("DELETE FROM request_proofs WHERE nonce = ? AND created_at > ? RETURNING nonce").bind(nonce, cutoff).first();
  return !!row;
}

async function send(fetcher: Fetcher, path: string, body: unknown): Promise<Record<string, any>> {
  const r = await fetcher(`${QUEUE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) throw new ApiError(502, "queue_unreachable", "The Porchsite request queue didn't answer. Try again later.");
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (!r.ok) throw new ApiError(r.status === 429 ? 429 : 502, j.error ?? "queue_refused", j.message ?? `The request queue answered ${r.status}.`);
  return j;
}

export async function file(
  db: D1Database,
  origin: string,
  actor: string,
  input: { type: string; title: string; description: string; examples: string[] },
  fetcher: Fetcher = fetch,
) {
  const j = await send(fetcher, "/requests", { origin: `${origin}/`, nonce: await newProof(db), ...input });
  await db.prepare("INSERT OR IGNORE INTO theme_requests (id, title, filed_by, created_at) VALUES (?, ?, ?, ?)").bind(j.id, input.title, actor, new Date().toISOString()).run();
  return { id: j.id, status: j.status };
}

/** This site's requests and where each stands; empty (with a note) if the queue is down. */
export async function mine(db: D1Database, fetcher: Fetcher = fetch) {
  const { results } = await db.prepare("SELECT id, title, created_at FROM theme_requests ORDER BY created_at DESC LIMIT 50").all<{ id: string; title: string; created_at: string }>();
  if (!results.length) return [];
  const r = await fetcher(`${QUEUE}/requests/status?ids=${results.map((x) => x.id).join(",")}`).catch(() => null);
  const status = new Map<string, { status: string; theme: string }>();
  if (r?.ok) for (const s of ((await r.json()) as { requests: { id: string; status: string; theme: string }[] }).requests) status.set(s.id, s);
  return results.map((x) => ({ ...x, status: status.get(x.id)?.status ?? "unknown", theme: status.get(x.id)?.theme ?? "" }));
}

// --- sharing a look this site made ---------------------------------------------------

/**
 * Share a look. author_x (optional): the X handle to credit, without the @;
 * the queue answers with a claim code the maker posts from that account, and
 * the look is credited only once the curator has seen the post.
 */
export async function submit(db: D1Database, origin: string, actor: string, name: string, note: string, fetcher: Fetcher = fetch, author_x?: string) {
  const row = await db.prepare("SELECT version, package, source FROM themes WHERE name = ?").bind(name).first<{ version: string; package: string; source: string }>();
  if (!row || row.source !== "private") throw new ApiError(404, "no_such_look", `This site has no look of its own called ${name}. theme_create makes one.`);
  const j = await send(fetcher, "/submissions", { origin: `${origin}/`, nonce: await newProof(db), package: row.package, note, ...(author_x ? { author_x } : {}) });
  await db.prepare("INSERT OR IGNORE INTO theme_submissions (id, name, version, submitted_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(j.id, name, row.version, actor, new Date().toISOString()).run();
  return { id: j.id, status: j.status, ...(j.credit ? { credit: j.credit } : {}) };
}

const CREDIT = new Set(["waiting", "credited", "not credited"]);

/**
 * This site's shared looks and where each stands. A look that claimed credit
 * also has credit: waiting (the curator hasn't checked the post yet),
 * credited, or not credited.
 */
export async function mySubmissions(db: D1Database, fetcher: Fetcher = fetch) {
  const { results } = await db.prepare("SELECT id, name, version, created_at FROM theme_submissions ORDER BY created_at DESC LIMIT 50").all<{ id: string; name: string; version: string; created_at: string }>();
  if (!results.length) return [];
  const r = await fetcher(`${QUEUE}/submissions/status?ids=${results.map((x) => x.id).join(",")}`).catch(() => null);
  const status = new Map<string, { status: string; note: string; credit?: string }>();
  if (r?.ok) for (const s of ((await r.json()) as { submissions: { id: string; status: string; note: string; credit?: string }[] }).submissions) status.set(s.id, s);
  return results.map((x) => {
    const s = status.get(x.id);
    const credit = s?.credit && CREDIT.has(s.credit) ? s.credit : "";
    return { ...x, status: s?.status ?? "unknown", note: s?.note ?? "", ...(credit ? { credit } : {}) };
  });
}
