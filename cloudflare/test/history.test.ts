// Whole-site revert (spec S5, §5): the owner puts the site back to an earlier publish, as a new publish.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import * as history from "../src/history";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;
const who = "assistant:Helper";
const at = (path: string, init?: RequestInit) => handle(new Request(`https://site.example${path}`, init), e);

async function publish(ids: string[]) {
  const req = await approvals.request(db, who, ids, "");
  await approvals.decide(db, req.id, Object.fromEntries(ids.map((id) => [id, { decision: "approve" }])), "");
}

async function signedIn(): Promise<string> {
  const token = "history-test-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await db.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)![1];

describe("whole-site revert", () => {
  it("lists publishes and puts the whole site back as a new publish", async () => {
    const s = await content.createItem(db, who, "site", { title: "Kettle", tagline: "Tea." }, undefined);
    await publish([s.id]); // 1
    const a = await content.createItem(db, who, "entry", { title: "First pot", date: "2026-10-01" }, undefined);
    await publish([a.id]); // 2
    const s2 = await content.updateItem(db, who, s.id, s.version, { tagline: "Coffee." });
    const b = await content.createItem(db, who, "entry", { title: "Switching", date: "2026-10-02" }, undefined);
    await publish([s2.id, b.id]); // 3
    // A draft on the site item: the revert sets it aside, and it stays in history.
    const draft = await content.updateItem(db, who, s.id, s2.version, { tagline: "Cocoa?" });

    const cookie = await signedIn();
    const list = await (await at("/review/history", { headers: { Cookie: cookie } })).text();
    expect(list.indexOf("Switching")).toBeLessThan(list.indexOf("First pot"));
    expect(list).toContain("you approved Helper&#39;s request");
    expect(list).toContain('<p class="meta">This is the site now.</p>');
    expect(list).toContain('<a class="go" href="/review/history/2">Put the site back to this →</a>');

    const confirm = await (await at("/review/history/2", { headers: { Cookie: cookie } })).text();
    expect(confirm).toContain("<h1>Put the site back?</h1>");
    expect(confirm).toContain('<h2 style="margin-top:8px">Your site&#39;s text and look</h2><div class="meta">site · put back</div>');
    expect(confirm).toContain('<h2 style="margin-top:8px">Switching</h2><div class="meta">entry · taken off</div>');
    expect(confirm).not.toContain("First pot");

    const body = new FormData();
    body.set("csrf", csrfOf(confirm));
    body.set("note", "Wrong tagline");
    const done = await at("/review/history/2", { method: "POST", body, headers: { Cookie: cookie } });
    expect(await done.text()).toContain("<h1>Your site is back</h1>");
    const home = await (await at("/")).text();
    expect(home).toContain("Tea.");
    expect(home).not.toContain("Coffee.");
    expect(home).not.toContain("Switching");
    expect(home).toContain("First pot");
    const last = (await history.publishes(db))[0];
    expect(last).toMatchObject({ id: 4, actor: "owner", approval_id: null, note: "Put the site back to publish 2: Wrong tagline" });
    expect(last.items.map((i) => [i.label, i.removed])).toEqual([
      ["Switching", true],
      ["Your site's text and look", false],
    ]);
    const versions = await content.history(db, s.id);
    expect(versions[0]).toMatchObject({ version: draft.version + 1, action: "revert", actor: "owner" });
    expect(versions[0].data.tagline).toBe("Tea.");
    expect(versions[1].data.tagline).toBe("Cocoa?");
    expect(await (await at("/review/history", { headers: { Cookie: cookie } })).text()).toContain("<p>Put the site back to publish 2: Wrong tagline</p>");

    // A revert can itself be reverted.
    await history.revert(db, 3, "");
    const again = await (await at("/")).text();
    expect(again).toContain("Coffee.");
    expect(again).toContain("Switching");
    expect((await history.publishes(db))[0].note).toBe("Put the site back to publish 3");
  });

  it("never brings a card back more visible than it is now", async () => {
    const c = await content.createItem(db, who, "card", { name: "Lantern", description: "Old words." }, undefined);
    await publish([c.id]); // 6
    const c2 = await content.updateItem(db, who, c.id, c.version, { description: "New words.", visibility: "private" });
    await publish([c2.id]); // 7
    await history.revert(db, 6, "");
    const now = await content.getItem(db, c.id);
    expect(now.data).toMatchObject({ description: "Old words.", visibility: "private" });
  });

  it("says when the site already matches, and refuses a stale form", async () => {
    const cookie = await signedIn();
    const latest = (await history.publishes(db))[0].id;
    expect(await (await at(`/review/history/${latest}`, { headers: { Cookie: cookie } })).text()).toContain("<p>The site already matches this.</p>");
    const body = new FormData();
    body.set("csrf", "nope");
    const stale = await (await at("/review/history/2", { method: "POST", body, headers: { Cookie: cookie } })).text();
    expect(stale).toContain('<p class="error">This form expired. Try again.</p>');
    const ok = new FormData();
    ok.set("csrf", csrfOf(stale));
    const same = await (await at(`/review/history/${latest}`, { method: "POST", body: ok, headers: { Cookie: cookie } })).text();
    expect(same).toContain('<p class="error">The site already matches that publish.</p>');
    expect((await at("/review/history")).status).toBe(303);
    expect((await at("/review/history/999", { headers: { Cookie: cookie } })).status).toBe(404);
  });
});
