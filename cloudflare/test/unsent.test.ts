// /review says how many changes nobody has sent for review (SPEC §5).
// Port-matched: server/tests/app/test_web_unsent.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;
const who = "assistant:test";

async function signedIn(): Promise<string> {
  const token = "unsent-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await db.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

describe("unsent changes", () => {
  it("counts changes no open request covers, and /review says so", async () => {
    const base = await approvals.unsent(db);
    const c = await content.createItem(db, who, "card", { name: "Ledger", description: "Books.", visibility: "public" }, undefined);
    expect(await approvals.unsent(db)).toBe(base + 1);
    // An unfinished entry draft doesn't count.
    await content.createItem(db, who, "entry", { title: "Half", date: "2026-10-10", body: "x", status: "draft" }, undefined);
    expect(await approvals.unsent(db)).toBe(base + 1);
    // Sent: it's waiting, not unsent.
    const r = await approvals.request(db, who, [c.id], "");
    expect(await approvals.unsent(db)).toBe(base);
    // Changed again after sending: that newer version isn't sent.
    await content.updateItem(db, who, c.id, c.version, { description: "Books, kept." });
    expect(await approvals.unsent(db)).toBe(base + 1);
    const page = await (await handle(new Request("https://site.example/review", { headers: { Cookie: await signedIn() } }), e)).text();
    expect(page).toMatch(/<p class="meta">There (is 1 change|are \d+ changes) not yet sent to you for review\. Nothing goes live until you approve it\.<\/p>/);
    expect(r.id).toBeTruthy();
  });
});
