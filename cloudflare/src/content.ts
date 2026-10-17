import { streamWrite, checkStreamSettings } from "./stream-settings";
import { brokerWrite } from "./site-fields";
import { storedData, sourceData, sourceWrite, migrateSources } from "./embed-storage";
/**
 * Every content write goes through here, so the safety rules always apply:
 * versions (S3), idempotency (S4), revisions (S5) and the guard (S6).
 */
import { embedSources } from "./embed-url";
import { z } from "zod";
import { ApiError } from "./errors";
import { checkGuard } from "./guard";
import { localize } from "./media";
import { KINDS, type Kind, MODELS, PREFIX, SITE_ID } from "./models";
import { checkSave } from "./visibility";

export interface Item {
  /** Set when an idempotency key returned an item created earlier. */
  replayed?: boolean;
  id: string;
  kind: Kind;
  slug: string | null;
  version: number;
  data: Record<string, unknown>;
  deleted: boolean;
  created_at: string;
  updated_at: string;
}

interface Row {
  id: string;
  kind: string;
  slug: string | null;
  version: number;
  data: string;
  deleted: number;
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();

export function toItem(r: Row): Item {
  return { ...r, kind: r.kind as Kind, data: JSON.parse(r.data), deleted: !!r.deleted };
}

function newId(kind: Kind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${PREFIX[kind]}_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function validate(kind: string, data: unknown): Record<string, unknown> {
  if (!KINDS.includes(kind as Kind)) {
    throw new ApiError(422, "invalid", `kind must be one of: ${KINDS.join(", ")}.`);
  }
  // Cards called their badge "status" before it was renamed (it was easy to
  // read as a publishing state).
  if (kind === "card" && data && typeof data === "object" && "status" in data && !("badge" in data)) {
    const { status, ...rest } = data as Record<string, unknown>;
    data = { ...rest, badge: status };
  }
  // The site's entries heading became its first stream when streams arrived.
  if (kind === "site" && data && typeof data === "object" && "entries_title" in data) {
    const { entries_title, ...rest } = data as Record<string, unknown>;
    data = "streams" in rest ? rest : { ...rest, streams: [{ id: "journal", title: entries_title }] };
  }
  const parsed = MODELS[kind as Kind].safeParse(data);
  if (!parsed.success) {
    throw new ApiError(422, "invalid", "The content doesn't validate. Fix the listed fields and resend.", {
      problems: parsed.error.issues.map((i) => ({ field: i.path.join("."), problem: i.message })),
    });
  }
  const out = parsed.data as Record<string, unknown>;
  if (kind === "site") {
    try { out.embed_sources = embedSources(out.embed_sources as string[]); }
    catch (e) { throw new ApiError(422, "invalid", "The content doesn't validate. Fix the listed fields and resend.", { problems: [{field: "embed_sources", problem: "Use distinct public https:// origins, without a path, login, query or fragment."}] }); }
    const ids = (out.streams as { id: string }[]).map((x) => x.id);
    const bad = (out.sections as string[]).filter((x) => !["entries", "cards", "notes", "about", ...ids].includes(x));
    if (bad.length) {
      throw new ApiError(422, "invalid", "The content doesn't validate. Fix the listed fields and resend.", {
        problems: [{ field: "sections", problem: `${bad.join(", ")}: not a stream id or one of entries, cards, notes, about (streams: ${ids.join(", ")})` }],
      });
    }
  }
  return out;
}

/** An entry's stream must be one the site has. */
async function checkStream(db: D1Database, kind: string, data: Record<string, unknown>): Promise<void> {
  if (kind !== "entry" || !data.stream) return;
  const ids = ((await siteData(db, false)).streams as { id: string }[]).map((x) => x.id);
  if (!ids.includes(String(data.stream))) {
    throw new ApiError(422, "invalid", "The content doesn't validate. Fix the listed fields and resend.", {
      problems: [{ field: "stream", problem: `the site has no stream "${data.stream}"; it has: ${ids.join(", ")}. Add a stream to the site item first` }],
    });
  }
}

/**
 * An entry's address, made once when it is created: its date and title
 * words, or the title words alone in a stream with dated_addresses false.
 */
function slugFor(kind: Kind, data: Record<string, unknown>, dated = true): string | null {
  if (kind !== "entry") return null;
  const words = String(data.title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, "");
  return dated ? `${data.date}-${words || "entry"}` : words || "entry";
}

/** Whether the entry's stream gives new entries dated addresses. */
async function datedStream(db: D1Database, data: Record<string, unknown>): Promise<boolean> {
  const streams = (await siteData(db, false)).streams as { id: string; dated_addresses?: boolean }[];
  const s = streams.find((x) => x.id === data.stream) ?? streams[0];
  return s.dated_addresses !== false;
}

/** An entry's chosen slug travels in its data but is kept on the item, not in it. */
function takeSlug(data: Record<string, unknown>): [string | undefined, Record<string, unknown>] {
  const { slug, ...rest } = data;
  return [slug as string | undefined, rest];
}

async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getItem(db: D1Database, id: string): Promise<Item> {
  const row = await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Row>();
  if (!row) throw new ApiError(404, "not_found", `No item ${id}.`);
  return { ...toItem(row), data: await sourceData(db, row.id, row.version, JSON.parse(row.data)) };
}

// Many at once: a 30-item review is a few queries, not a few per item (each
// D1 query is a round trip). Ids go in as one JSON array, so there's no
// limit on how many.

/** Items by id; ids not found are left out. */
export async function itemsByIds(db: D1Database, ids: string[]): Promise<Map<string, Item>> {
  if (!ids.length) return new Map();
  const { results } = await db.prepare("SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<Row>();
  return new Map(await Promise.all(results.map(async r => [r.id, { ...toItem(r), data: await sourceData(db, r.id, r.version, JSON.parse(r.data)) }] as const)));
}

/** What's live for these ids. */
export async function liveByIds(db: D1Database, ids: string[]): Promise<Map<string, { data: string; slug: string | null; version: number }>> {
  if (!ids.length) return new Map();
  const { results } = await db
    .prepare("SELECT item_id, data, slug, version FROM live WHERE item_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<{ item_id: string; data: string; slug: string | null; version: number }>();
  return new Map(await Promise.all(results.map(async r => [r.item_id, { ...r, data: JSON.stringify(await sourceData(db, r.item_id, r.version, JSON.parse(r.data), true)) }] as const)));
}

/** Revisions at exact versions, keyed "id@version". */
export async function revisionsAt(db: D1Database, at: { id: string; version: number }[]): Promise<Map<string, { data: string; deleted: number }>> {
  if (!at.length) return new Map();
  const { results } = await db
    .prepare(
      "SELECT r.item_id, r.version, r.data, r.deleted FROM json_each(?) j JOIN revisions r ON r.item_id = json_extract(j.value, '$.id') AND r.version = json_extract(j.value, '$.version')",
    )
    .bind(JSON.stringify(at.map((x) => ({ id: x.id, version: x.version }))))
    .all<{ item_id: string; version: number; data: string; deleted: number }>();
  return new Map(await Promise.all(results.map(async r => [`${r.item_id}@${r.version}`, { data: JSON.stringify(await sourceData(db, r.item_id, r.version, JSON.parse(r.data))), deleted: r.deleted }] as const)));
}

export async function allItems(db: D1Database): Promise<Item[]> {
  const { results } = await db.prepare("SELECT * FROM items ORDER BY kind, created_at").all<Row>();
  return Promise.all(results.map(async r => ({ ...toItem(r), data: await sourceData(db, r.id, r.version, JSON.parse(r.data)) })));
}

/** The site item, with defaults filled in, whether or not it has been edited. */
export async function siteData(db: D1Database, live: boolean): Promise<Record<string, unknown>> {
  const sql = live ? "SELECT data, version FROM live WHERE item_id = ?" : "SELECT data, version FROM items WHERE id = ?";
  const row = await db.prepare(sql).bind(SITE_ID).first<{ data: string; version: number }>();
  return validate("site", row ? await sourceData(db, SITE_ID, row.version, JSON.parse(row.data), live) : {});
}

async function write(
  db: D1Database,
  item: Omit<Item, "created_at" | "updated_at">,
  expected: number | null,
  action: string,
  actor: string,
  reason: string,
  from: string | null = null,
): Promise<Item> {
  await migrateSources(db);
  const at = now();
  const data = JSON.stringify(storedData(item.kind, item.data));
  const stmts =
    expected === null
      ? [
          db
            .prepare(
              "INSERT INTO items (id, kind, slug, version, data, deleted, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 0, ?, ?)",
            )
            .bind(item.id, item.kind, item.slug, data, at, at),
        ]
      : [
          db
            .prepare("UPDATE items SET data = ?, slug = ?, deleted = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
            .bind(data, item.slug, item.deleted ? 1 : 0, at, item.id, expected),
        ];
  // The revision is written only if the item now has the new version, so a
  // lost race leaves no stray history.
  stmts.push(
    db
      .prepare(
        `INSERT INTO revisions (item_id, version, action, data, deleted, actor, reason, created_at)
         SELECT id, version, ?, data, deleted, ?, ?, ? FROM items WHERE id = ? AND version = ?
           AND changes() = 1`,
      )
      .bind(action, actor, reason, at, item.id, item.version),
  );
  if (item.kind === "site") stmts.push(streamWrite(db, item.version, item.data), sourceWrite(db, item.version, item.data), brokerWrite(db, item.version, item.data));
  // A changed address is remembered, so the old one can send visitors on.
  if (expected !== null && from && item.slug && from !== item.slug) {
    stmts.push(
      db
        .prepare("INSERT INTO slug_history (item_id, version, slug, new_slug, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1")
        .bind(item.id, item.version, from, item.slug, at),
    );
  }
  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (e) {
    if (String(e).includes("UNIQUE") && String(e).includes("slug")) {
      throw new ApiError(409, "slug_taken", `Another entry already has the address ${item.slug}. Choose a different slug, or change the title.`);
    }
    if (expected === null || !String(e).includes("UNIQUE")) throw e;
    results = [{ meta: { changes: 0 } } as unknown as D1Result];
  }
  if (expected !== null && results[0].meta.changes !== 1) {
    const current = await getItem(db, item.id);
    throw new ApiError(409, "version_conflict", `Item ${item.id} is at version ${current.version}, not ${expected}. Re-read it and redo your change.`, {
      current_version: current.version,
    });
  }
  return getItem(db, item.id);
}

export async function createItem(
  db: D1Database,
  actor: string,
  kind: string,
  input: unknown,
  idempotencyKey: string | undefined,
): Promise<Item> {
  await migrateSources(db);
  const data = validate(kind, input);
  if (kind === "site") checkStreamSettings(data);
  checkGuard(data);
  await checkStream(db, kind, data);
  await checkSave(db, kind, null, data, null);
  const reqHash = await sha(JSON.stringify([kind, data]));
  if (idempotencyKey) {
    const prior = await db
      .prepare("SELECT request_hash, response FROM idempotency WHERE actor = ? AND key = ?")
      .bind(actor, idempotencyKey)
      .first<{ request_hash: string; response: string }>();
    if (prior) {
      if (prior.request_hash !== reqHash) {
        throw new ApiError(409, "idempotency_mismatch", "This idempotency key was used for a different request.");
      }
      return { ...JSON.parse(prior.response), replayed: true };
    }
  }
  if (kind === "site") {
    const exists = await db.prepare("SELECT version FROM items WHERE id = ?").bind(SITE_ID).first();
    if (exists) throw new ApiError(409, "exists", "The site item already exists. Use item_update.");
  }
  const k = kind as Kind;
  const id = k === "site" ? SITE_ID : newId(k);
  // After the replay check, so a retried create doesn't fetch its images again.
  const [chosen, rest] = takeSlug(data);
  const slug = k === "entry" ? (chosen ?? slugFor(k, rest, await datedStream(db, rest))) : null;
  const stored = await localize(db, k, rest);
  const item = await write(db, { id, kind: k, slug, version: 1, data: stored, deleted: false }, null, "create", actor, "");
  if (idempotencyKey) {
    await db
      .prepare("INSERT OR IGNORE INTO idempotency (actor, key, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(actor, idempotencyKey, reqHash, JSON.stringify(item), now())
      .run();
  }
  return item;
}

export async function updateItem(
  db: D1Database,
  actor: string,
  id: string,
  version: number,
  patch: Record<string, unknown>,
  reason = "",
): Promise<Item> {
  const current = await getItem(db, id);
  if (current.deleted) throw new ApiError(409, "deleted", `Item ${id} is removed. Roll it back first.`);
  const [chosen, checked] = takeSlug(validate(current.kind, { ...current.data, ...patch }));
  if (current.kind === "site") checkStreamSettings(checked);
  checkGuard(checked);
  await checkStream(db, current.kind, checked);
  await checkSave(db, current.kind, id, checked, current.kind === "card" ? String(current.data.visibility ?? "public") : null);
  const data = await localize(db, current.kind, checked);
  return write(
    db,
    { ...current, data, slug: chosen ?? current.slug ?? slugFor(current.kind, data), version: version + 1 },
    version,
    "update",
    actor,
    reason,
    current.slug,
  );
}

export async function removeItem(db: D1Database, actor: string, id: string, version: number, reason = ""): Promise<Item> {
  const current = await getItem(db, id);
  if (current.kind === "site") throw new ApiError(422, "invalid", "The site item can't be removed; change it instead.");
  return write(db, { ...current, deleted: true, version: version + 1 }, version, "remove", actor, reason);
}

export async function history(db: D1Database, id: string) {
  await getItem(db, id);
  const { results } = await db
    .prepare("SELECT version, action, data, deleted, actor, reason, created_at FROM revisions WHERE item_id = ? ORDER BY version DESC")
    .bind(id)
    .all<{ version: number; action: string; data: string; deleted: number; actor: string; reason: string; created_at: string }>();
  const moves = await db
    .prepare("SELECT version, slug, new_slug FROM slug_history WHERE item_id = ?")
    .bind(id)
    .all<{ version: number; slug: string; new_slug: string }>();
  const moved = new Map(moves.results.map((m) => [m.version, { from: m.slug, to: m.new_slug }]));
  return Promise.all(results.map(async (r) => ({
    ...r,
    data: await sourceData(db, id, r.version, JSON.parse(r.data)),
    deleted: !!r.deleted,
    ...(moved.has(r.version) ? { address_change: moved.get(r.version) } : {}),
  })));
}

export async function rollback(db: D1Database, actor: string, id: string, toVersion: number, version: number, reason = ""): Promise<Item> {
  const current = await getItem(db, id);
  const old = await db
    .prepare("SELECT data, deleted FROM revisions WHERE item_id = ? AND version = ?")
    .bind(id, toVersion)
    .first<{ data: string; deleted: number }>();
  if (!old) throw new ApiError(404, "not_found", `Item ${id} has no version ${toVersion}.`);
  let data = await sourceData(db, id, toVersion, JSON.parse(old.data));
  // A rollback never changes a card's visibility; that stays an explicit change.
  if (current.kind === "card") data = { ...data, visibility: current.data.visibility ?? "public" };
  checkGuard(data);
  if (!old.deleted) await checkSave(db, current.kind, id, data, current.kind === "card" ? String(current.data.visibility ?? "public") : null);
  return write(
    db,
    { ...current, data, deleted: !!old.deleted, slug: current.slug ?? slugFor(current.kind, data), version: version + 1 },
    version,
    "rollback",
    actor,
    reason || `back to version ${toVersion}`,
  );
}

/**
 * Put an item back to `data` (or removed) as a new version, for a whole-site
 * revert; the guard runs as on every write.
 */
export async function restore(db: D1Database, actor: string, id: string, version: number, data: Record<string, unknown>, deleted: boolean, reason: string): Promise<Item> {
  const current = await getItem(db, id);
  if (!deleted) checkGuard(data);
  return write(db, { ...current, data, deleted, slug: current.slug ?? slugFor(current.kind, data), version: version + 1 }, version, "revert", actor, reason);
}

/**
 * Where an entry's old address (/<stream>/<old slug>/, or /e/<old slug>/)
 * leads now: the page of the entry that last had that slug, if it is live.
 */
export async function movedAddress(db: D1Database, entries: Record<string, any>[], streams: Record<string, any>[], path: string): Promise<string | null> {
  const m = /^\/([a-z][a-z0-9-]{0,29})\/([a-z0-9-]{1,80})\/?$/.exec(path);
  if (!m) return null;
  const row = await db
    .prepare("SELECT item_id FROM slug_history WHERE slug = ? ORDER BY created_at DESC, version DESC LIMIT 1")
    .bind(m[2])
    .first<{ item_id: string }>();
  const e = row && entries.find((x) => x.id === row.item_id);
  if (!e || e.page === path) return null;
  const s = streams.find((x) => x.id === e.stream);
  return s && [s.path || s.id, s.id, "e"].includes(m[1]) ? e.page : null;
}

/** Items whose current state differs from what is live: what an approval can cover. */
export async function staged(db: D1Database): Promise<(Item & { live_version: number | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT i.*, l.version AS live_version FROM items i LEFT JOIN live l ON l.item_id = i.id
        WHERE (l.item_id IS NULL AND i.deleted = 0) OR (l.item_id IS NOT NULL AND l.version <> i.version)
        ORDER BY i.updated_at`,
    )
    .all<Row & { live_version: number | null }>();
  return Promise.all(results.map(async r => ({ ...toItem(r), data: await sourceData(db, r.id, r.version, JSON.parse(r.data)), live_version: r.live_version })));
}

export const DataPatch = z.record(z.string(), z.unknown());
