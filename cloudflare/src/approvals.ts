import { invalidation } from "./public-artifacts";
import { streamApproval } from "./stream-settings";
import { fieldsApproval, privateApproval, trainingApproval } from "./site-fields";
import { storedData, sourceData, sourceApproval, migrateSources } from "./embed-storage";
/**
 * The owner's yes (SPEC S1, S2). An assistant asks for named items at their
 * current versions; only the owner's decision publishes, and only exactly
 * what was shown.
 */
import { embedSources, requestOrigin } from "./embed-url";
import { type Item, allItems, getItem, itemsByIds, staged } from "./content";
import { ApiError } from "./errors";
import { checkPublic } from "./visibility";

export type ItemStatus = "pending" | "published" | "changes_requested" | "denied" | "superseded";

export interface ApprovalItem {
  id: string;
  version: number;
  kind: string;
  label: string;
  change: "new" | "changed" | "removed";
  status: ItemStatus;
  note: string;
}

export interface Approval {
  id: string;
  items: ApprovalItem[];
  note: string;
  requested_by: string;
  status: "pending" | "decided";
  decision_note: string;
  created_at: string;
  decided_at: string | null;
}

interface Row {
  id: string;
  items: string;
  note: string;
  requested_by: string;
  status: string;
  decision_note: string;
  created_at: string;
  decided_at: string | null;
}

const now = () => new Date().toISOString();

function toApproval(r: Row): Approval {
  return { ...r, items: JSON.parse(r.items), status: r.status as Approval["status"] };
}

export function label(item: Pick<Item, "kind" | "data">): string {
  const d = item.data as Record<string, string>;
  return d.title ?? d.name ?? d.text ?? item.kind;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

export async function request(db: D1Database, actor: string, ids: string[], note: string): Promise<Approval> {
  await migrateSources(db);
  if (!ids.length) throw new ApiError(422, "invalid", "Name at least one item.");
  const pending = new Map((await staged(db)).map((i) => [i.id, i]));
  const items: ApprovalItem[] = [];
  for (const id of [...new Set(ids)]) {
    const item = pending.get(id) ?? (await getItem(db, id));
    if (!pending.has(id)) {
      throw new ApiError(409, "nothing_to_approve", `Item ${id} is the same as what's live. Change it first.`);
    }
    if (item.kind === "entry" && item.data.status === "draft" && !item.deleted) {
      throw new ApiError(409, "draft", `Entry ${id} is a draft. Set status to "ready" first.`);
    }
    const live = (pending.get(id) as { live_version: number | null }).live_version;
    items.push({
      id,
      version: item.version,
      kind: item.kind,
      label: label(item),
      change: item.deleted ? "removed" : live === null ? "new" : "changed",
      status: "pending",
      note: "",
    });
  }
  // A newer request for an item replaces the item in any older open request.
  const open = await listRaw(db, "pending");
  const stmts: D1PreparedStatement[] = [];
  for (const a of open) {
    let touched = false;
    for (const it of a.items) {
      if (it.status === "pending" && ids.includes(it.id)) {
        it.status = "superseded";
        touched = true;
      }
    }
    if (touched) stmts.push(updateStmt(db, a));
  }
  const approval: Approval = {
    id: newId(),
    items,
    note: note.slice(0, 1000),
    requested_by: actor,
    status: "pending",
    decision_note: "",
    created_at: now(),
    decided_at: null,
  };
  stmts.push(
    db
      .prepare("INSERT INTO approvals (id, items, note, requested_by, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .bind(approval.id, JSON.stringify(items), approval.note, actor, approval.created_at),
  );
  await db.batch(stmts);
  return approval;
}

function updateStmt(db: D1Database, a: Approval): D1PreparedStatement {
  const done = a.items.every((i) => i.status !== "pending");
  return db
    .prepare("UPDATE approvals SET items = ?, status = ?, decision_note = ?, decided_at = ? WHERE id = ?")
    .bind(JSON.stringify(a.items), done ? "decided" : "pending", a.decision_note, done ? (a.decided_at ?? now()) : null, a.id);
}

async function listRaw(db: D1Database, status?: string): Promise<Approval[]> {
  const sql = status
    ? "SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 100"
    : "SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100";
  const stmt = status ? db.prepare(sql).bind(status) : db.prepare(sql);
  return (await stmt.all<Row>()).results.map(toApproval);
}

/** An approval with each pending item checked against the item's current version. */
export async function get(db: D1Database, id: string): Promise<Approval> {
  const row = await db.prepare("SELECT * FROM approvals WHERE id = ?").bind(id).first<Row>();
  if (!row) throw new ApiError(404, "not_found", `No approval ${id}.`);
  return freshen(db, toApproval(row));
}

/** Each pending item checked against its item's current version: one query for all of them. */
async function freshenAll(db: D1Database, all: Approval[]): Promise<Approval[]> {
  const pending = all.flatMap((a) => a.items.filter((it) => it.status === "pending"));
  const cur = await itemsByIds(db, [...new Set(pending.map((it) => it.id))]);
  for (const it of pending) if (cur.get(it.id)?.version !== it.version) it.status = "superseded";
  for (const a of all) if (a.items.every((i) => i.status !== "pending")) a.status = "decided";
  return all;
}

async function freshen(db: D1Database, a: Approval): Promise<Approval> {
  return (await freshenAll(db, [a]))[0];
}

export async function list(db: D1Database, status?: string): Promise<Approval[]> {
  return freshenAll(db, await listRaw(db, status));
}

export type Decision = "approve" | "changes" | "deny" | "later";

/**
 * Apply the owner's decisions. Approved items go live in one batch, at the
 * exact version the owner saw; an item edited since is refused, not published.
 */
export async function decide(
  db: D1Database,
  id: string,
  decisions: Record<string, { decision: Decision; note?: string }>,
  overall: string,
  origin = "",
): Promise<{ approval: Approval; published: string[] }> {
  await migrateSources(db);
  const a = await get(db, id);
  const stmts: D1PreparedStatement[] = [];
  const published: string[] = [];
  const going: Item[] = [];
  const at = now();
  const current = await itemsByIds(db, a.items.filter((it) => decisions[it.id]?.decision === "approve" && it.status === "pending").map((it) => it.id));
  for (const it of a.items) {
    const d = decisions[it.id];
    if (!d || d.decision === "later" || it.status !== "pending") continue;
    it.note = (d.note ?? "").slice(0, 2000);
    if (d.decision === "deny") it.status = "denied";
    else if (d.decision === "changes") it.status = "changes_requested";
    else {
      const item = current.get(it.id);
      if (!item || item.version !== it.version) {
        it.status = "superseded";
        continue;
      }
      checkEmbedOrigin(item, origin);
      stmts.push(liveStmt(db, item, at));
      if (item.kind === "site") stmts.push(streamApproval(db, item.version), sourceApproval(db, item.version), fieldsApproval(db, item.version), privateApproval(db,item.version), trainingApproval(db,item.version));
      going.push(item);
      it.status = "published";
      published.push(item.id);
    }
  }
  // Nothing public may name a private card: refused before anything changes.
  if (going.length) await checkPublic(db, await liveWith(db, going));
  a.decision_note = overall.slice(0, 2000) || a.decision_note;
  if (a.items.every((i) => i.status !== "pending")) a.decided_at = at;
  stmts.push(updateStmt(db, a));
  if (published.length) {
    stmts.push(...invalidation(db));
    stmts.push(
      db
        .prepare("INSERT INTO publishes (actor, approval_id, items, created_at) VALUES ('owner', ?, ?, ?)")
        .bind(a.id, JSON.stringify(a.items.filter((i) => published.includes(i.id)).map((i) => ({ id: i.id, version: i.version }))), at),
    );
  }
  await db.batch(stmts);
  return { approval: await get(db, id), published };
}

function liveStmt(db: D1Database, item: Item, at: string): D1PreparedStatement {
  return item.deleted
    ? db.prepare("DELETE FROM live WHERE item_id = ?").bind(item.id)
    : db
        .prepare(
          `INSERT INTO live (item_id, kind, slug, version, data, published_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (item_id) DO UPDATE SET slug = excluded.slug, version = excluded.version,
             data = excluded.data, published_at = excluded.published_at`,
        )
        .bind(item.id, item.kind, item.slug, item.version, JSON.stringify(storedData(item.kind, item.data)), at);
}

/** The site as it would be with these items published on top of what's live (rows shaped like `live`). */
export async function liveWith(db: D1Database, items: Item[]): Promise<{ id: string; kind: string; data: Record<string, unknown> }[]> {
  const { results } = await db.prepare("SELECT item_id, kind, data, version FROM live ORDER BY item_id").all<{ item_id: string; kind: string; data: string; version: number }>();
  const rows = new Map(await Promise.all(results.map(async r => [r.item_id, { id: r.item_id, kind: r.kind, data: await sourceData(db, r.item_id, r.version, JSON.parse(r.data), true) }] as const)));
  for (const it of items) {
    if (it.deleted) rows.delete(it.id);
    else rows.set(it.id, { id: it.id, kind: it.kind, data: it.data });
  }
  return [...rows.values()];
}

/**
 * The owner publishes exactly these items, at exactly these versions, with
 * no approval request (the owner is the approver): the writing desk and the
 * whole-site revert. An item changed since is refused (item_changed). A
 * pending request for the same version is marked published.
 */
export async function publishNow(db: D1Database, items: { id: string; version: number }[], note: string, origin = ""): Promise<string[]> {
  await migrateSources(db);
  const going: Item[] = [];
  for (const want of items) {
    const item = await getItem(db, want.id);
    if (item.version !== want.version) {
      throw new ApiError(409, "item_changed", `${item.id} changed since (version ${want.version} → ${item.version}). Reload and try again.`, { id: item.id, current_version: item.version });
    }
    checkEmbedOrigin(item, origin);
    going.push(item);
  }
  if (!going.length) return [];
  await checkPublic(db, await liveWith(db, going));
  const at = now();
  const stmts = going.flatMap(i => i.kind === "site" ? [liveStmt(db, i, at), streamApproval(db, i.version), sourceApproval(db, i.version), fieldsApproval(db, i.version), privateApproval(db,i.version), trainingApproval(db,i.version)] : [liveStmt(db, i, at)]);
  for (const a of await listRaw(db, "pending")) {
    let touched = false;
    for (const it of a.items) {
      if (it.status === "pending" && going.some((g) => g.id === it.id && g.version === it.version)) {
        it.status = "published";
        touched = true;
      }
    }
    if (touched) stmts.push(updateStmt(db, a));
  }
  stmts.push(
    db
      .prepare("INSERT INTO publishes (actor, approval_id, items, created_at, note) VALUES ('owner', NULL, ?, ?, ?)")
      .bind(JSON.stringify(going.map((i) => ({ id: i.id, version: i.version }))), at, note.slice(0, 1000)),
  );
  stmts.push(...invalidation(db));
  await db.batch(stmts);
  return going.map((i) => i.id);
}

/**
 * How many items have a change no open request covers: the current version
 * isn't live and isn't waiting for the owner. Unfinished entry drafts don't
 * count. /review says so, so a change nobody sent isn't invisible.
 */
export async function unsent(db: D1Database): Promise<number> {
  const live = new Map(
    (await db.prepare("SELECT item_id, version FROM live").all<{ item_id: string; version: number }>()).results.map((r) => [r.item_id, r.version]),
  );
  const asked = new Set<string>();
  for (const a of await list(db, "pending")) for (const i of a.items) if (i.status === "pending") asked.add(`${i.id}@${i.version}`);
  let n = 0;
  for (const i of await allItems(db)) {
    const lv = live.get(i.id);
    if (i.deleted ? lv === undefined : lv === i.version) continue;
    if (!i.deleted && i.kind === "entry" && i.data.status === "draft") continue;
    if (!asked.has(`${i.id}@${i.version}`)) n++;
  }
  return n;
}

function checkEmbedOrigin(item: Item, origin: string): void {
  if (item.kind !== "site" || item.deleted) return;
  const sources = embedSources((item.data.embed_sources ?? []) as string[]);
  if (origin && sources.includes(requestOrigin(origin))) throw new ApiError(422, "invalid", "An embed source cannot be this site's own origin.");
}
