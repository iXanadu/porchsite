/**
 * Card visibility (SPEC §3): public, mention or private. A private card is
 * never shown and its name may not appear in anything public; a mention card
 * shows its name and description only, and an entry names it at most once in
 * its summary and once in its body. Checked when content is saved (with the
 * guard, S6) and again when anything is published.
 */
import { ApiError } from "./errors";

export const RANK: Record<string, number> = { private: 0, mention: 1, public: 2 };

type Data = Record<string, unknown>;
interface Named {
  id: string;
  name: string;
}

const visOf = (d: Data): string => String(d.visibility ?? "public");

/** Every string in a value, joined, as the guard reads content. */
function text(v: unknown, out: string[] = []): string {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => text(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => text(x, out));
  return out.join("\n");
}

/** A whole-word, case-insensitive match for any of these names, or null. */
export function nameRule(names: string[]): RegExp | null {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!clean.length) return null;
  const alts = clean.map((n) => n.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");
  return new RegExp(`(?<![A-Za-z0-9_])(?:${alts})(?![A-Za-z0-9_])`, "giu");
}

const count = (rx: RegExp, s: string) => (s.match(rx) ?? []).length;

/** The cards not removed, with their current (unapproved included) data. */
async function cards(db: D1Database): Promise<{ id: string; data: Data }[]> {
  const { results } = await db.prepare("SELECT id, data FROM items WHERE kind = 'card' AND deleted = 0 ORDER BY created_at, id").all<{ id: string; data: string }>();
  return results.map((r) => ({ id: r.id, data: JSON.parse(r.data) }));
}

const withVis = (all: { id: string; data: Data }[], vis: string): Named[] =>
  all.filter((c) => visOf(c.data) === vis).map((c) => ({ id: c.id, name: String(c.data.name ?? "") }));

/** What a card's own text is checked as: everything but its name (a card may name itself). */
const checkedPart = (kind: string, data: Data): Data => {
  if (kind !== "card") return data;
  const { name: _n, ...rest } = data;
  return rest;
};

/**
 * On every save. `before` is the item's visibility before this write (null
 * for a new item).
 */
export async function checkSave(db: D1Database, kind: string, id: string | null, data: Data, before: string | null): Promise<void> {
  const all = await cards(db);
  const others = all.filter((c) => c.id !== id);
  const privateCard = kind === "card" && visOf(data) === "private";
  // A private card's own text never goes public, so it may name anything.
  if (!privateCard) {
    const priv = withVis(others, "private");
    const rx = nameRule(priv.map((c) => c.name));
    const found = rx ? text(checkedPart(kind, data)).match(rx) : null;
    if (found) {
      const hit = priv.find((c) => nameRule([c.name])!.test(found[0]));
      throw new ApiError(422, "content_guard", 'This names a private card. Leave its name out (say "an unannounced project"), or make the card public first.', {
        rule: "a private card's name",
        card: hit?.id ?? "",
      });
    }
  }
  if (kind === "entry") {
    for (const c of withVis(others, "mention")) {
      const rx = nameRule([c.name]);
      if (!rx) continue;
      for (const field of ["summary", "body"]) {
        if (count(rx, String(data[field] ?? "")) > 1) {
          throw new ApiError(422, "mention_limit", `This entry names "${c.name.trim()}" more than once in its ${field}. A card shown as a mention gets one line: name it once, or make the card public.`, {
            card: c.id,
            field,
          });
        }
      }
    }
  }
  // Making a card private must not leave its name in other items.
  if (privateCard && before !== "private") {
    const rx = nameRule([String(data.name ?? "")]);
    if (!rx) return;
    const { results } = await db.prepare("SELECT id, kind, data FROM items WHERE deleted = 0 ORDER BY created_at, id").all<{ id: string; kind: string; data: string }>();
    const users = results
      .filter((r) => r.id !== id)
      .filter((r) => {
        const d = JSON.parse(r.data) as Data;
        if (r.kind === "card" && visOf(d) === "private") return false;
        return count(rx, text(d)) > 0;
      })
      .map((r) => r.id);
    if (users.length) {
      throw new ApiError(409, "name_in_use", `Other items still name "${String(data.name).trim()}". Change them first, then make the card private.`, { items: users });
    }
  }
}

/**
 * Before anything goes live: no public text in the site as it would be
 * (`rows`, shaped like `live`) may name a private card, private there or in
 * the current, unapproved content.
 */
export async function checkPublic(db: D1Database, rows: { id: string; kind: string; data: Data }[]): Promise<void> {
  const priv = new Map<string, string>();
  for (const r of rows) if (r.kind === "card" && visOf(r.data) === "private") priv.set(r.id, String(r.data.name ?? ""));
  for (const c of withVis(await cards(db), "private")) priv.set(c.id, c.name);
  if (!priv.size) return;
  const problems: { id: string; kind: string; label: string }[] = [];
  for (const r of rows) {
    if (r.kind === "card" && visOf(r.data) === "private") continue;
    if (r.kind === "entry" && r.data.status === "draft") continue;
    const rx = nameRule([...priv].filter(([id]) => id !== r.id).map(([, n]) => n));
    if (rx && rx.test(text(checkedPart(r.kind, r.data)))) {
      const d = r.data as Record<string, string>;
      problems.push({ id: r.id, kind: r.kind, label: d.title ?? d.name ?? d.text ?? r.kind });
    }
  }
  if (problems.length) {
    throw new ApiError(422, "content_guard", `Some items can't go public as they stand: they name a private card (${problems.map((p) => p.label).join(", ")}). Change them, then try again.`, {
      items: problems,
    });
  }
}

export interface Raise {
  id: string;
  name: string;
  from: string;
  to: string;
}

/** Cards these item versions would show more of than the live site does (private → mention → public). */
export async function raises(db: D1Database, items: { id: string; version: number; kind: string }[]): Promise<Raise[]> {
  const out: Raise[] = [];
  const cards = items.filter((it) => it.kind === "card");
  if (!cards.length) return out;
  // Two queries for the lot (content.ts's revisionsAt / liveByIds, inlined: content imports this module).
  const revs = new Map(
    (
      await db
        .prepare("SELECT r.item_id, r.version, r.data, r.deleted FROM json_each(?) j JOIN revisions r ON r.item_id = json_extract(j.value, '$.id') AND r.version = json_extract(j.value, '$.version')")
        .bind(JSON.stringify(cards.map((x) => ({ id: x.id, version: x.version }))))
        .all<{ item_id: string; version: number; data: string; deleted: number }>()
    ).results.map((r) => [`${r.item_id}@${r.version}`, r]),
  );
  const lives = new Map(
    (
      await db
        .prepare("SELECT item_id, data FROM live WHERE item_id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(cards.map((x) => x.id)))
        .all<{ item_id: string; data: string }>()
    ).results.map((r) => [r.item_id, r]),
  );
  for (const it of cards) {
    const rev = revs.get(`${it.id}@${it.version}`);
    const live = lives.get(it.id);
    if (!rev || rev.deleted || !live) continue;
    const now = JSON.parse(rev.data) as Data;
    const was = visOf(JSON.parse(live.data));
    const to = visOf(now);
    if ((RANK[to] ?? 2) > (RANK[was] ?? 2)) out.push({ id: it.id, name: String(now.name ?? ""), from: was, to });
  }
  return out;
}
