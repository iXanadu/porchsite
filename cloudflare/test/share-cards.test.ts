// Share cards (SPEC §5): the owner's browser draws each published entry's card;
// the site lists what's missing, keeps what's sent, and shares it.
// Port-matched: server/tests/app/test_web_share_cards.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import * as media from "../src/media";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;
const who = "assistant:test";
// Enough of a JPEG for the type and size checks: SOI, then an SOF0 with height and width.
const jpeg = (w: number, h: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, ...new Array(64).fill(7)]);

async function signedIn(): Promise<string> {
  const token = "cards-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await db.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}
async function publish(ids: string[]) {
  const req = await approvals.request(db, who, ids, "");
  await approvals.decide(db, req.id, Object.fromEntries(ids.map((id) => [id, { decision: "approve" }])), "");
}

describe("share cards", () => {
  it("lists what's missing, keeps what the owner's browser sends, and shares it", async () => {
    const cookie = await signedIn();
    const at = (path: string, init: RequestInit = {}) => handle(new Request(`https://site.example${path}`, { ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string>) } }), e);
    const s = await content.createItem(db, who, "site", { title: "Kettle", theme: "personal-homepage" }, undefined);
    const cover = await media.store(db, jpeg(1600, 900), "image/jpeg", "test");
    const en = await content.createItem(db, who, "entry", { title: "When it looks done", date: "2026-10-12", cover, cover_alt: "A boat" }, undefined);
    await publish([s.id, en.id]);

    const page = await (await at("/review")).text();
    expect(page).toContain('<div id="share-cards" hidden data-csrf="');
    const csrf = /id="share-cards" hidden data-csrf="([^"]+)"/.exec(page)![1];
    const list = (await (await at("/review/cards.json")).json()) as { cards: { id: string; version: number; title: string; label: string; photo: string }[] };
    expect(list.cards).toEqual([{ id: en.id, version: 1, title: "When it looks done", label: "Updates · site.example", photo: cover }]);

    const send = (body: Uint8Array, token = csrf, version = 1) => at(`/review/cards/${en.id}?version=${version}`, { method: "POST", headers: { "Content-Type": "image/jpeg", "X-CSRF": token }, body });
    expect((await send(jpeg(1200, 630), "nope")).status).toBe(403);
    expect((await send(jpeg(800, 600))).status).toBe(422);
    expect((await send(jpeg(1200, 630), csrf, 2)).status).toBe(409);
    expect((await send(jpeg(1200, 630))).status).toBe(204);
    expect(((await (await at("/review/cards.json")).json()) as { cards: unknown[] }).cards).toEqual([]);

    const card = await db.prepare("SELECT name FROM share_cards WHERE item_id = ?").bind(en.id).first<{ name: string }>();
    const entryPage = await (await handle(new Request(`https://site.example/journal/${en.slug}/`), e)).text();
    expect(entryPage).toContain(`<meta property="og:image" content="https://site.example/media/${card!.name}">`);
    expect((await handle(new Request(`https://site.example/media/${card!.name}`), e)).status).toBe(200);

    // A new version of the entry wants a new card.
    const en2 = await content.updateItem(db, who, en.id, en.version, { title: "When it looks done, it might not be" });
    await publish([en2.id]);
    expect(((await (await at("/review/cards.json")).json()) as { cards: { version: number }[] }).cards.map((c) => c.version)).toEqual([2]);
  });
});
