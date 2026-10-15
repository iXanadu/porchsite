/**
 * The site's past publishes, and putting the whole site back to one of them
 * (SPEC S5, §5 /review/history). A revert is the owner's own act: every item
 * that differs from how it was at that publish gets a new version with its
 * content from then (or is taken off), and those versions go live together
 * as a new publish, recorded with the owner's note. Nothing is deleted:
 * the revert is itself in the history and can be reverted.
 */
import { embedSources, requestOrigin } from "./embed-url";
import { liveWith, publishNow } from "./approvals";
import * as content from "./content";
import { SITE_ID } from "./models";
import { ApiError } from "./errors";
import { RANK } from "./visibility";
import { checkPublic } from "./visibility";

type Data = Record<string, unknown>;

export interface PublishedItem {
  id: string;
  version: number;
  kind: string;
  label: string;
  removed: boolean;
}

export interface Publish {
  id: number;
  actor: string;
  approval_id: string | null;
  requested_by: string;
  note: string;
  created_at: string;
  items: PublishedItem[];
}

export interface Change {
  id: string;
  kind: string;
  label: string;
  action: "put back" | "take off";
  data: Data;
  deleted: boolean;
  /** What is live now (null when the item isn't on the site). */
  live: Data | null;
}

interface Row {
  id: number;
  actor: string;
  approval_id: string | null;
  items: string;
  note: string;
  created_at: string;
}

export function labelOf(kind: string, data: Data): string {
  if (kind === "site") return "Your site's text and look";
  const d = data as Record<string, string>;
  return d.title ?? d.name ?? d.text ?? kind;
}

async function revision(db: D1Database, id: string, version: number) {
  return db
    .prepare("SELECT r.data, r.deleted, i.kind FROM revisions r JOIN items i ON i.id = r.item_id WHERE r.item_id = ? AND r.version = ?")
    .bind(id, version)
    .first<{ data: string; deleted: number; kind: string }>();
}

async function toPublish(db: D1Database, r: Row): Promise<Publish> {
  const items: PublishedItem[] = [];
  for (const it of JSON.parse(r.items) as { id: string; version: number }[]) {
    const rev = await revision(db, it.id, it.version);
    const kind = rev?.kind ?? "";
    items.push({ id: it.id, version: it.version, kind, label: rev ? labelOf(kind, JSON.parse(rev.data)) : it.id, removed: !!rev?.deleted });
  }
  const req = r.approval_id ? await db.prepare("SELECT requested_by FROM approvals WHERE id = ?").bind(r.approval_id).first<{ requested_by: string }>() : null;
  return { id: r.id, actor: r.actor, approval_id: r.approval_id, requested_by: req?.requested_by ?? "", note: r.note ?? "", created_at: r.created_at, items };
}

/** The newest publishes first. */
export async function publishes(db: D1Database, limit = 50): Promise<Publish[]> {
  const { results } = await db.prepare("SELECT * FROM publishes ORDER BY id DESC LIMIT ?").bind(limit).all<Row>();
  const out: Publish[] = [];
  for (const r of results) out.push(await toPublish(db, r));
  return out;
}

export async function getPublish(db: D1Database, id: number): Promise<Publish> {
  const row = await db.prepare("SELECT * FROM publishes WHERE id = ?").bind(id).first<Row>();
  if (!row) throw new ApiError(404, "not_found", `No publish ${id}.`);
  return toPublish(db, row);
}

/** Which version of each item was live just after this publish. */
async function stateAt(db: D1Database, id: number): Promise<Map<string, number>> {
  const { results } = await db.prepare("SELECT items FROM publishes WHERE id <= ? ORDER BY id").bind(id).all<{ items: string }>();
  const state = new Map<string, number>();
  for (const r of results) for (const it of JSON.parse(r.items) as { id: string; version: number }[]) state.set(it.id, it.version);
  return state;
}

/**
 * What putting the site back to this publish changes. A card that's live now
 * never comes back more visible than it is now (private → mention → public
 * stays an explicit change).
 */
export async function plan(db: D1Database, id: number): Promise<{ publish: Publish; changes: Change[] }> {
  const publish = await getPublish(db, id);
  const state = await stateAt(db, id);
  const { results } = await db.prepare("SELECT item_id, version, data FROM live").all<{ item_id: string; version: number; data: string }>();
  const live = new Map(results.map((r) => [r.item_id, { version: r.version, data: JSON.parse(r.data) as Data }]));
  const ids = [...new Set([...state.keys(), ...live.keys()])].sort();
  const changes: Change[] = [];
  for (const itemId of ids) {
    const lv = live.get(itemId);
    let want = state.get(itemId);
    const rev = want === undefined ? null : await revision(db, itemId, want);
    if (rev?.deleted) want = undefined;
    if (want === undefined && !lv) continue;
    if (lv && want === lv.version) continue;
    // The site's text is never taken off or reset to placeholder words: a
    // publish from before it was first published leaves it as it is.
    if (want === undefined && itemId === SITE_ID) continue;
    const item = await content.getItem(db, itemId);
    let data: Data;
    let deleted = false;
    if (want === undefined) {
      data = item.data;
      deleted = true;
    } else {
      data = JSON.parse(rev!.data);
      if (item.kind === "card" && lv) {
        const then = String(data.visibility ?? "public");
        const nowVis = String(lv.data.visibility ?? "public");
        if ((RANK[then] ?? 2) > (RANK[nowVis] ?? 2)) data = { ...data, visibility: nowVis };
      }
    }
    if (!deleted && lv && JSON.stringify(data) === JSON.stringify(lv.data)) continue;
    changes.push({ id: itemId, kind: item.kind, label: labelOf(item.kind, deleted ? item.data : data), action: deleted ? "take off" : "put back", data, deleted, live: lv?.data ?? null });
  }
  return { publish, changes };
}

/** Put the site back to this publish, as a new publish by the owner. */
export async function revert(db: D1Database, id: number, note: string, origin = ""): Promise<{ published: string[] }> {
  const { publish, changes } = await plan(db, id);
  if (!changes.length) throw new ApiError(409, "nothing_to_revert", "The site already matches that publish.");
  for (const c of changes) if (c.kind === "site" && !c.deleted && embedSources((c.data.embed_sources ?? []) as string[]).includes(requestOrigin(origin))) throw new ApiError(422,"invalid","An embed source cannot be this site's own origin.");
  // Checked before anything is written, so a refusal leaves no stray versions.
  await checkPublic(db, await liveWith(db, changes.map((c) => ({ ...c, slug: null, version: 0, created_at: "", updated_at: "", kind: c.kind as content.Item["kind"] }))));
  const reason = `back to the site as published ${publish.created_at.slice(0, 16).replace("T", " ")} UTC`;
  const going: { id: string; version: number }[] = [];
  for (const c of changes) {
    const item = await content.getItem(db, c.id);
    const done = await content.restore(db, "owner", c.id, item.version, c.data, c.deleted, reason);
    going.push({ id: done.id, version: done.version });
  }
  const words = `Put the site back to publish ${id}${note.trim() ? `: ${note.trim()}` : ""}`;
  return { published: await publishNow(db, going, words, origin) };
}
