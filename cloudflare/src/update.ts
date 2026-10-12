/**
 * Whether a newer Porchsite release is published (SPEC §4, "Updates").
 * Informational only: the site never downloads, installs or applies
 * anything. It reads HOME/latest.json at most once a day (the answer is kept
 * in KV; a failed fetch is silent and tried again the next day), and
 * site_state and the owner's review pages say what it found. The assistant
 * updates on the owner's say-so, following the install guide's "Updating".
 * Port: server/server/app/updates.py.
 */
import { HOME, RELEASE } from "./home";

export const LATEST_URL = `${HOME}/latest.json`;
export const HOW = `${HOME}/docs/install/#updating`;
export const CACHE_KEY = "porchsite:update-check";
export const DAY_MS = 86_400_000;
export const TIMEOUT_MS = 3000;
/** A published release id: <UTC date>-<commit>. Anything else (dev, test, a local build) never checks. */
export const RELEASE_ID = /^(\d{4}\.\d{2}\.\d{2})-[0-9a-f]{7,40}$/;

export interface Release {
  release: string;
  security: boolean;
  reconnect: boolean;
  migrations: string[];
  changes: string[];
}
export type Update =
  | { available: false }
  | { available: true; latest: string; security: boolean; changes: string[]; migrations: string[]; reconnect: boolean; how: string };
/** What the cache keeps: when it last asked, and the newest releases it heard of (null: never heard). */
interface Cached {
  checked_at: number;
  latest: string | null;
  releases: Release[];
}

/** For tests: the running release and the fetch the check uses. */
export const runtime = {
  release: RELEASE,
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function release(v: Record<string, unknown>, id: unknown): Release | null {
  if (typeof id !== "string" || !RELEASE_ID.test(id)) return null;
  return { release: id, security: v.security === true, reconnect: v.reconnect === true, migrations: strings(v.migrations), changes: strings(v.changes) };
}

/** latest.json, reduced to what the notice needs: newest first. */
export function parseLatest(body: unknown): { latest: string; releases: Release[] } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const top = release(b, b.version);
  if (!top) return null;
  const list = Array.isArray(b.releases)
    ? b.releases.flatMap((r) => (r && typeof r === "object" ? [release(r as Record<string, unknown>, (r as Record<string, unknown>).release)] : [])).filter((r): r is Release => r !== null)
    : [];
  return { latest: top.release, releases: list.length && list[0].release === top.release ? list.slice(0, 200) : [top] };
}

/** What the running release lacks, from the cached releases (pure). */
export function compare(running: string, latest: string | null, releases: Release[]): Update {
  const m = RELEASE_ID.exec(running);
  const l = latest ? RELEASE_ID.exec(latest) : null;
  if (!m || !l || latest === running) return { available: false };
  const at = releases.findIndex((r) => r.release === running);
  let newer: Release[];
  if (at >= 0) newer = releases.slice(0, at);
  else if (l[1] > m[1]) newer = releases.filter((r) => RELEASE_ID.exec(r.release)![1] > m[1]);
  else return { available: false }; // a build that isn't published, or newer than what is
  if (!newer.length) return { available: false };
  return {
    available: true,
    latest: latest!,
    security: newer.some((r) => r.security),
    changes: newer.flatMap((r) => r.changes),
    migrations: [...new Set(newer.flatMap((r) => r.migrations))].sort(),
    reconnect: newer.some((r) => r.reconnect),
    how: HOW,
  };
}

async function readCache(kv: KVNamespace): Promise<Cached | null> {
  try {
    const v = await kv.get<Cached>(CACHE_KEY, "json");
    return v && typeof v.checked_at === "number" ? v : null;
  } catch {
    return null;
  }
}

/** The update notice for this site: asks HOME at most once a day. Never throws. */
export async function check(kv: KVNamespace, now = Date.now()): Promise<Update> {
  const running = runtime.release;
  if (!RELEASE_ID.test(running)) return { available: false };
  let cached = await readCache(kv);
  if (!cached || now - cached.checked_at >= DAY_MS || now < cached.checked_at) {
    let fresh: { latest: string; releases: Release[] } | null = null;
    try {
      const r = await runtime.fetch(LATEST_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) fresh = parseLatest(await r.json());
    } catch {
      // Silent: tried again tomorrow.
    }
    cached = { checked_at: now, latest: fresh?.latest ?? cached?.latest ?? null, releases: fresh?.releases ?? cached?.releases ?? [] };
    try {
      await kv.put(CACHE_KEY, JSON.stringify(cached));
    } catch {
      // A cache that can't be written only means asking again next time.
    }
  }
  return compare(running, cached.latest, cached.releases);
}

/** The owner's one quiet line, or nothing. */
export function noticeHtml(u: Update, esc: (s: string) => string): string {
  if (!u.available) return "";
  return u.security
    ? `<p class="warn"><b>Security update:</b> a newer Porchsite is available (${esc(u.latest)}). Ask your assistant to update it.</p>`
    : `<p class="meta">A newer Porchsite is available (${esc(u.latest)}). Ask your assistant to update it.</p>`;
}
