// The review page says what changed without opening anything: old → new per field, a word diff
// for long text, the whole content for a new item, a plain line for a removal.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as changes from "../src/changes";
import * as content from "../src/content";
import type { Env } from "../src/env";
import * as history from "../src/history";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;
const who = "assistant:test";

async function publish(ids: string[]) {
  const req = await approvals.request(db, who, ids, "");
  await approvals.decide(db, req.id, Object.fromEntries(ids.map((id) => [id, { decision: "approve" }])), "");
}

async function signedIn(): Promise<string> {
  const token = "review-changes-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await db.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

async function reviewOf(ids: string[]): Promise<string> {
  const r = await approvals.request(db, who, ids, "");
  const cookie = await signedIn();
  return (await handle(new Request(`https://site.example/review/${r.id}`, { headers: { Cookie: cookie } }), e)).text();
}

const WORDS = Array.from({ length: 40 }, (_, i) => `w${i}`);

describe("review: what changed", () => {
  it("shows a changed card's fields old → new, open, before the separate decision", async () => {
    const c = await content.createItem(db, who, "card", { name: "Ledger", description: "Books kept by hand.", visibility: "public" }, undefined);
    await publish([c.id]);
    const c2 = await content.updateItem(db, who, c.id, c.version, { description: "Books kept for you.", visibility: "mention" });
    const page = await reviewOf([c2.id]);
    expect(page).toContain("Changed card: Ledger");
    expect(page).toContain('<details class="changed" open><summary class="meta" style="cursor:pointer">What changed</summary>');
    expect(page).toContain('<div class="field"><b>Description</b><div class="value"><span class="old">Books kept by hand.</span> → Books kept for you.</div></div>');
    expect(page).toContain('<div class="field"><b>Visibility</b><div class="value"><span class="old">public</span> → mention</div></div>');
    expect(page).toMatch(/<p class="meta">\d+ other fields unchanged<\/p>/);
    expect(page).not.toContain("What it says");
    // The advanced path stays shut, and comes after what changed.
    expect(page).toContain('<details class="one"><summary class="meta" style="cursor:pointer">Decide this one separately</summary>');
    expect(page.indexOf("What changed")).toBeLessThan(page.indexOf("Decide this one separately"));

    // /review/history's detail uses the same rows: putting it back changes the description back.
    await approvals.decide(db, (await approvals.list(db))[0].id, { [c2.id]: { decision: "approve" } }, "");
    const before = (await history.publishes(db)).find((p) => p.items.some((i) => i.id === c.id && i.version === c.version))!;
    const back = await (await handle(new Request(`https://site.example/review/history/${before.id}`, { headers: { Cookie: await signedIn() } }), e)).text();
    expect(back).toContain('<div class="field"><b>Description</b><div class="value"><span class="old">Books kept for you.</span> → Books kept by hand.</div></div>');
  });

  it("shows a long body as a word diff, not two copies", async () => {
    const body = WORDS.join(" ");
    const a = await content.createItem(db, who, "entry", { title: "Long read", date: "2026-10-01", body }, undefined);
    await publish([a.id]);
    const edited = WORDS.map((w) => (w === "w20" ? "twenty" : w)).join(" ");
    const a2 = await content.updateItem(db, who, a.id, a.version, { body: edited });
    const page = await reviewOf([a2.id]);
    expect(page).toContain('<div class="field"><b>Text</b><div class="value diff">… w14 w15 w16 w17 w18 w19 <del>w20</del> <ins>twenty</ins> w21 w22 w23 w24 w25 w26 …</div></div>');
    expect(page).not.toContain(body);
  });

  it("shows a new item's content open", async () => {
    const c = await content.createItem(db, who, "card", { name: "Brand new", description: "Fresh from the kiln." }, undefined);
    const page = await reviewOf([c.id]);
    expect(page).toContain("New card: Brand new");
    expect(page).toContain('<details open><summary class="meta" style="cursor:pointer">What it says</summary>');
    expect(page).toContain('<div class="field"><b>Description</b><div class="value">Fresh from the kiln.</div></div>');
    expect(page).not.toContain("What changed");
  });

  it("says plainly that a removed item will be taken off", async () => {
    const c = await content.createItem(db, who, "card", { name: "Old stall", description: "Closed." }, undefined);
    await publish([c.id]);
    const gone = await content.removeItem(db, who, c.id, c.version);
    const page = await reviewOf([gone.id]);
    expect(page).toContain("<p>This will be taken off the site: <b>Old stall</b></p>");
  });

  it("escapes every value", async () => {
    const c = await content.createItem(db, who, "card", { name: "Plain", description: "Nothing odd." }, undefined);
    await publish([c.id]);
    const c2 = await content.updateItem(db, who, c.id, c.version, { description: '<script>alert("x")</script>' });
    const page = await reviewOf([c2.id]);
    expect(page).toContain("→ &#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;</div>");
    expect(page).not.toContain("<script>alert");
  });
});

describe("review: defaults", () => {
  it("doesn't call a field changed when one version leaves it out and the other stores its default", () => {
    const old = { name: "Ledger", description: "Books." };
    const now = content.validate("card", { name: "Ledger", description: "Books." });
    expect(String(changes.whatChanged("card", now, old))).toContain("Nothing you would see differs from what is live.");
    const moved = String(changes.whatChanged("card", { ...now, description: "Books, kept." }, old));
    expect(moved).toContain("<b>Description</b>");
    expect(moved).not.toContain("<b>Visibility</b>");
  });
});
