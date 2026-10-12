// Card visibility (spec §3): public, mention or private, checked when saved and when published.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import { ApiError } from "../src/errors";
import { handle } from "../src/routes";
import * as site from "../src/site";

const e = env as unknown as Env;
const db = e.DB;
const who = "assistant:test";
const at = (path: string, init?: RequestInit) => handle(new Request(`https://site.example${path}`, init), e);

async function publish(ids: string[]) {
  const req = await approvals.request(db, who, ids, "");
  await approvals.decide(db, req.id, Object.fromEntries(ids.map((id) => [id, { decision: "approve" }])), "");
}

async function refused(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (x) {
    if (x instanceof ApiError) return x;
    throw x;
  }
  throw new Error("expected a refusal");
}

async function signedIn(): Promise<string> {
  const token = "visibility-test-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await db.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

describe("card visibility", () => {
  it("shows a public card whole, a mention as name and description, a private card never", async () => {
    const s = await content.createItem(db, who, "site", { title: "Kettle", cards_title: "Things" }, undefined);
    const pub = await content.createItem(db, who, "card", { name: "Teapot", description: "Pours.", link: "https://example.com/teapot", link_label: "See the teapot" }, undefined);
    expect(pub.data.visibility).toBe("public");
    const men = await content.createItem(db, who, "card", { name: "Sieve", description: "Strains.", link: "https://example.com/sieve", link_label: "See the sieve", visibility: "mention" }, undefined);
    const pri = await content.createItem(db, who, "card", { name: "Lantern", description: "Lantern glows.", link: "https://example.com/lantern", visibility: "private" }, undefined);
    await publish([s.id, pub.id, men.id, pri.id]);
    const v = await site.liveView(db);
    expect(v.cards.map((c) => c.name)).toEqual(["Sieve", "Teapot"]);
    expect(v.cards.find((c) => c.name === "Sieve")).toMatchObject({ link: "", link_label: "", image: "", image_alt: "", description: "Strains." });
    const home = await (await at("/")).text();
    expect(home).toContain("See the teapot");
    expect(home).toContain("Sieve");
    expect(home).toContain("Strains.");
    expect(home).not.toContain("See the sieve");
    expect(home).not.toContain("example.com/sieve");
    expect(home).not.toContain("Lantern");
    expect((await refused(content.createItem(db, who, "card", { name: "Cup", description: "Holds.", visibility: "hidden" }, undefined))).code).toBe("invalid");
  });

  it("refuses content that names a private card, as a whole word in any case", async () => {
    const hit = await refused(content.createItem(db, who, "entry", { title: "News", date: "2026-10-01", summary: "Working on the LANTERN." }, undefined));
    expect(hit.code).toBe("content_guard");
    expect(hit.message).toContain("private card");
    expect((hit.toJSON() as Record<string, unknown>).rule).toBe("a private card's name");
    // Part of a longer word isn't the name; a card may name itself.
    const ok = await content.createItem(db, who, "entry", { title: "News", date: "2026-10-01", summary: "Lanterns everywhere." }, undefined);
    expect(ok.version).toBe(1);
    expect((await refused(content.updateItem(db, who, ok.id, 1, { body: "Soon: lantern." }))).code).toBe("content_guard");
    const pri = (await content.allItems(db)).find((i) => i.data.name === "Lantern")!;
    expect((await content.updateItem(db, who, pri.id, pri.version, { description: "The Lantern, brighter." })).version).toBe(pri.version + 1);
  });

  it("refuses making a card private while other items name it", async () => {
    const teapot = (await content.allItems(db)).find((i) => i.data.name === "Teapot")!;
    const n = await content.createItem(db, who, "note", { text: "Polished the teapot.", date: "2026-10-02" }, undefined);
    const err = await refused(content.updateItem(db, who, teapot.id, teapot.version, { visibility: "private" }));
    expect(err.code).toBe("name_in_use");
    expect((err.toJSON() as Record<string, unknown>).items).toEqual([n.id]);
    await content.updateItem(db, who, n.id, 1, { text: "Polished something." });
    const made = await content.updateItem(db, who, teapot.id, teapot.version, { visibility: "private" });
    expect(made.data.visibility).toBe("private");
    // Back to public, for the cases below.
    await content.updateItem(db, who, teapot.id, made.version, { visibility: "public" });
  });

  it("lets an entry name a mention card once in its summary and once in its body", async () => {
    const twice = await refused(content.createItem(db, who, "entry", { title: "Sieves", date: "2026-10-03", summary: "The sieve, and the sieve again." }, undefined));
    expect(twice.code).toBe("mention_limit");
    expect(twice.message).toBe('This entry names "Sieve" more than once in its summary. A card shown as a mention gets one line: name it once, or make the card public.');
    expect((await refused(content.createItem(db, who, "entry", { title: "Sieves", date: "2026-10-03", body: "Sieve.\n\nSieve." }, undefined))).code).toBe("mention_limit");
    const once = await content.createItem(db, who, "entry", { title: "Sieves", date: "2026-10-03", summary: "A sieve.", body: "The sieve strains." }, undefined);
    expect(once.version).toBe(1);
  });

  it("keeps a card's visibility through a rollback", async () => {
    const c = await content.createItem(db, who, "card", { name: "Kettle lid", description: "Fits.", visibility: "mention" }, undefined);
    const c2 = await content.updateItem(db, who, c.id, 1, { description: "Fits snugly.", visibility: "public" });
    const back = await content.rollback(db, who, c.id, 1, c2.version);
    expect(back.data.description).toBe("Fits.");
    expect(back.data.visibility).toBe("public");
  });

  it("refuses to publish live text that names a private card", async () => {
    // Text written before the card was private (put in directly: every save refuses it now).
    const ent = await content.createItem(db, who, "entry", { title: "Old news", date: "2026-10-04", summary: "Nothing yet." }, undefined);
    const data = JSON.stringify({ ...ent.data, summary: "Working on the Lantern." });
    await db.batch([
      db.prepare("UPDATE items SET data = ? WHERE id = ?").bind(data, ent.id),
      db.prepare("UPDATE revisions SET data = ? WHERE item_id = ? AND version = 1").bind(data, ent.id),
    ]);
    const req = await approvals.request(db, who, [ent.id], "");
    const err = await refused(approvals.decide(db, req.id, { [ent.id]: { decision: "approve" } }, ""));
    expect(err.code).toBe("content_guard");
    expect(err.message).toContain("Old news");
    expect(await db.prepare("SELECT 1 FROM live WHERE item_id = ?").bind(ent.id).first()).toBeNull();
    expect((await approvals.get(db, req.id)).items[0].status).toBe("pending");
    // The owner sees why on the review page.
    const cookie = await signedIn();
    const review = await (await at(`/review/${req.id}`, { headers: { Cookie: cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(review)![1];
    const body = new FormData();
    body.set("csrf", csrf);
    body.set("all", "approve");
    const page = await (await at(`/review/${req.id}`, { method: "POST", body, headers: { Cookie: cookie } })).text();
    expect(page).toContain('<p class="error">Some items can&#39;t go public as they stand: they name a private card (Old news).');
  });

  it("warns on the review page and the preview when a change shows more of a card", async () => {
    const pri = (await content.allItems(db)).find((i) => i.data.name === "Lantern")!;
    const raised = await content.updateItem(db, who, pri.id, pri.version, { visibility: "public" });
    const req = await approvals.request(db, who, [raised.id], "");
    const cookie = await signedIn();
    const line = "Shows more: the card &#34;Lantern&#34; goes from private (not shown) to public (the whole card).";
    const review = await (await at(`/review/${req.id}`, { headers: { Cookie: cookie } })).text();
    expect(review).toContain(`<p class="warn">${line}</p>`);
    expect(await (await at(`/review/${req.id}/preview`, { headers: { Cookie: cookie } })).text()).toContain(line);
    // A change that shows less says nothing.
    const teapot = (await content.allItems(db)).find((i) => i.data.name === "Teapot")!;
    const lower = await content.updateItem(db, who, teapot.id, teapot.version, { visibility: "mention" });
    const quiet = await approvals.request(db, who, [lower.id], "");
    expect(await (await at(`/review/${quiet.id}`, { headers: { Cookie: cookie } })).text()).not.toContain('class="warn"');
  });
});
