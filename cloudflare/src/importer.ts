import { checkStreamSettings } from "./stream-settings";
/**
 * Importing content from a file (SPEC §5): for an assistant that can't reach
 * the site at all. It writes one JSON file; the owner uploads it at
 * /review/import. Every item goes through the same checks an assistant's
 * drafts do, and the lot becomes one approval request: nothing is public
 * until the owner approves it. Port-matched: server/server/app/importer.py.
 *
 *   {"porchsite_import": 1, "from": "<assistant>", "note": "<for the owner>",
 *    "items": [{"kind": "site" | "entry" | "card" | "note", "data": {...}}],
 *    "images": {"<name>.jpg": "<base64>"}}
 *
 * A data string "image:<name>" (alone, or inside Markdown as
 * ![what it shows](image:<name>)) becomes that image's /media path. A site
 * item's data changes only the fields it names.
 */
import { request } from "./approvals";
import { createItem, getItem, updateItem, validate } from "./content";
import { ApiError } from "./errors";
import { MAX_BYTES, sniff, store } from "./media";
import { KINDS, SITE_ID } from "./models";

export const MAX_FILE = 25 * 1024 * 1024;
const MAX_ITEMS = 200;
const REF = /image:([A-Za-z0-9._-]{1,80})/g;

function decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64.replace(/^data:[^,]*,/, "").replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "")), (c) => c.charCodeAt(0));
}

function swap(v: unknown, paths: Map<string, string>, missing: Set<string>): unknown {
  if (typeof v === "string")
    return v.replace(REF, (m, name: string) => {
      const p = paths.get(name);
      if (!p) missing.add(name);
      return p ?? m;
    });
  if (Array.isArray(v)) return v.map((x) => swap(x, paths, missing));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, paths, missing)]));
  return v;
}

export async function importFile(db: D1Database, text: string): Promise<{ approval: string; count: number }> {
  let file: Record<string, any>;
  try {
    file = JSON.parse(text);
  } catch {
    throw new ApiError(422, "invalid", "That file isn't JSON.");
  }
  if (!file || file.porchsite_import !== 1 || !Array.isArray(file.items)) throw new ApiError(422, "invalid", 'That isn\'t a Porchsite import file: it needs "porchsite_import": 1 and "items".');
  if (!file.items.length || file.items.length > MAX_ITEMS) throw new ApiError(422, "invalid", `An import has 1 to ${MAX_ITEMS} items.`);
  if (file.items.some((it: any) => it?.kind === "site" && it.data && Object.hasOwn(it.data, "private"))) throw new ApiError(422,"invalid","An import file cannot change private mode. Propose this separately for owner approval.");
  const actor = `assistant:${String(file.from ?? "import").trim().slice(0, 40) || "import"}`;

  // Pictures first: each is checked and stored like any upload.
  const paths = new Map<string, string>();
  for (const [name, b64] of Object.entries((file.images ?? {}) as Record<string, unknown>)) {
    let bytes: Uint8Array;
    try {
      bytes = decode(String(b64));
    } catch {
      throw new ApiError(422, "invalid", `The image ${name} isn't base64.`);
    }
    const type = sniff(bytes);
    if (!type) throw new ApiError(422, "not_an_image", `The image ${name} isn't a JPEG, PNG or WebP picture.`);
    if (bytes.length > MAX_BYTES) throw new ApiError(413, "too_large", `The image ${name} is over 8 MB.`);
    paths.set(name, await store(db, bytes, type, actor));
  }

  // Every item checked before any is saved.
  const missing = new Set<string>();
  const items = (file.items as Record<string, any>[]).map((it) => ({ kind: String(it?.kind ?? ""), data: swap(it?.data ?? {}, paths, missing) as Record<string, unknown> }));
  if (missing.size) throw new ApiError(422, "invalid", `The file names images it doesn't include: ${[...missing].join(", ")}.`);
  const site = await db.prepare("SELECT version, data FROM items WHERE id = ?").bind(SITE_ID).first<{ version: number; data: string }>();
  const logicalSite = site ? (await getItem(db, SITE_ID)).data : null;
  const problems: { item: number; error: string; message: string }[] = [];
  items.forEach((it, i) => {
    try {
      if (!KINDS.includes(it.kind as never)) throw new ApiError(422, "invalid", `kind must be one of: ${KINDS.join(", ")}.`);
      const checked = validate(it.kind, it.kind === "site" && site ? { ...logicalSite, ...it.data } : it.data);
      if (it.kind === "site") checkStreamSettings(checked);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      problems.push({ item: i + 1, error: e.code, message: e.message });
    }
  });
  if (problems.length) throw new ApiError(422, "invalid", problems.length === 1 ? "1 item in the file can't be used as it stands." : `${problems.length} items in the file can't be used as they stand.`, { problems });

  const ids: string[] = [];
  for (const it of items) {
    if (it.kind === "site" && site) {
      const cur = await getItem(db, SITE_ID);
      ids.push((await updateItem(db, actor, SITE_ID, cur.version, it.data, "import")).id);
    } else {
      ids.push((await createItem(db, actor, it.kind, it.data, undefined)).id);
    }
  }
  const a = await request(db, actor, ids, String(file.note ?? "").slice(0, 1000));
  return { approval: a.id, count: ids.length };
}
