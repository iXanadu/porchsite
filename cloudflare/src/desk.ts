/**
 * The owner's writing desk (SPEC §5, /review/write): the owner writes and
 * edits entries, and publishes one directly. The owner is the approver, so
 * the owner's own publish needs no approval request: it makes exactly that
 * entry, at the version on screen, live. Every write goes through content.ts
 * as the actor "owner", so versions, revisions and the guard all apply. Drafts
 * the assistant made show up here for the owner to finish.
 */
import { publishNow } from "./approvals";
import * as content from "./content";
import { ApiError } from "./errors";

/** What the form edits; everything else on the entry is left alone. */
export const FIELDS = ["stream", "title", "summary", "date", "tags", "cover", "cover_alt", "body"] as const;

export type DeskEntry = content.Item & { state: string; live_version: number | null };

function stateOf(item: content.Item, live: number | null): string {
  if (live === null) return item.data.status === "draft" ? "draft" : "ready, not live";
  return live === item.version ? "live" : "live, edited since";
}

async function liveVersion(db: D1Database, id: string): Promise<number | null> {
  const row = await db.prepare("SELECT version FROM live WHERE item_id = ?").bind(id).first<{ version: number }>();
  return row ? row.version : null;
}

/** Every entry not removed, newest first, with where it stands. */
export async function entries(db: D1Database): Promise<DeskEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT i.*, l.version AS live_version FROM items i LEFT JOIN live l ON l.item_id = i.id
        WHERE i.kind = 'entry' AND i.deleted = 0`,
    )
    .all<Record<string, unknown>>();
  return results
    .map((r) => {
      const item = content.toItem(r as never);
      const live = (r.live_version as number | null) ?? null;
      return { ...item, live_version: live, state: stateOf(item, live) };
    })
    .sort((a, b) => String(b.data.date).localeCompare(String(a.data.date)) || (b.created_at < a.created_at ? -1 : b.created_at > a.created_at ? 1 : 0));
}

export async function get(db: D1Database, id: string): Promise<DeskEntry> {
  const item = await content.getItem(db, id).catch(() => null);
  if (!item || item.kind !== "entry" || item.deleted) throw new ApiError(404, "not_found", "There is no entry at this address.");
  const live = await liveVersion(db, id);
  return { ...item, live_version: live, state: stateOf(item, live) };
}

/** Form strings to entry fields. An unchanged cover is left out, so it isn't fetched again. */
export function clean(form: Record<string, string>, current: Record<string, unknown> | null): Record<string, unknown> {
  const v = (k: string) => String(form[k] ?? "").trim();
  const data: Record<string, unknown> = {
    stream: v("stream"),
    title: v("title"),
    summary: v("summary"),
    date: v("date"),
    tags: v("tags").replace(/,/g, " ").split(/\s+/).filter(Boolean),
    cover: v("cover"),
    cover_alt: v("cover_alt"),
    body: String(form.body ?? "").replace(/\r\n/g, "\n").trim(),
  };
  if (current && data.cover === String(current.cover ?? "")) delete data.cover;
  return data;
}

/** Create (as a draft) or update an entry as the owner. */
export async function save(db: D1Database, id: string | null, version: number | null, form: Record<string, string>): Promise<content.Item> {
  if (id === null) return content.createItem(db, "owner", "entry", { ...clean(form, null), status: "draft" }, undefined);
  const current = await get(db, id);
  return content.updateItem(db, "owner", id, version ?? -1, clean(form, current.data), "owner edited");
}

/** Mark the entry ready and make exactly it live. */
export async function publish(db: D1Database, id: string, version: number): Promise<content.Item> {
  let item: content.Item = await get(db, id);
  if (item.data.status !== "ready") item = await content.updateItem(db, "owner", id, version, { status: "ready" }, "owner published");
  else if (item.version !== version) {
    throw new ApiError(409, "version_conflict", `Item ${id} is at version ${item.version}, not ${version}. Re-read it and redo your change.`, { current_version: item.version });
  }
  await publishNow(db, [{ id, version: item.version }], "published by the owner from the writing desk");
  return item;
}
