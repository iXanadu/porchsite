// The owner sees the site as it will look before approving: a theme switch included.
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
  const token = "preview-test-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await db.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

describe("review preview", () => {
  it("shows the proposed site, in the proposed theme, only to the owner", async () => {
    const s = await content.createItem(db, who, "site", { title: "Kettle", tagline: "Tea.", theme: "personal-homepage" }, undefined);
    const r1 = await approvals.request(db, who, [s.id], "");
    await approvals.decide(db, r1.id, { [s.id]: { decision: "approve" } }, "");
    const s2 = await content.updateItem(db, who, s.id, s.version, { tagline: "Tea, on time.", theme: "product-page", hero_caption: "Vol. I" });
    const r2 = await approvals.request(db, who, [s2.id], "");

    expect((await handle(new Request(`https://site.example/review/${r2.id}/preview`), e)).status).toBe(303);
    const cookie = await signedIn();
    const page = await handle(new Request(`https://site.example/review/${r2.id}/preview`, { headers: { Cookie: cookie } }), e);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const text = await page.text();
    expect(text).toContain("Preview: nothing is live yet.");
    // The proposed theme's own stylesheet (live is still personal-homepage), inline, with its palette.
    expect(text).toContain("<style>");
    expect(text).toContain(".numbers-rail");
    expect(text).toContain(":root{--bg:");
    expect(text).not.toContain('href="/static/site.css');
    expect(text).toContain('value="approve"');
    expect(text).toContain('<p class="dateline">Vol. I</p>');
    expect(text).toContain("<h1>Tea, on time.</h1>");
    // The public site hasn't changed.
    const live = await (await handle(new Request("https://site.example/"), e)).text();
    expect(live).not.toContain("Tea, on time.");
    const review = await (await handle(new Request(`https://site.example/review/${r2.id}`, { headers: { Cookie: cookie } }), e)).text();
    expect(review).toContain(`href="/review/${r2.id}/preview"`);
    expect(review).toContain("wants to change 1 thing on your site.");
    expect(review).toContain("Changes to your site&#39;s text and look");
    expect(review).toContain('<summary class="meta" style="cursor:pointer">What changed</summary><div class="field"><b>Headline</b><div class="value"><span class="old">Tea.</span> → Tea, on time.</div></div>');
    expect(review).not.toContain("version");
    // One big button approves everything waiting, and says so.
    const csrf = /name="csrf" value="([^"]+)"/.exec(review)![1];
    const body = new FormData();
    body.set("csrf", csrf);
    body.set("all", "approve");
    const done = await handle(new Request(`https://site.example/review/${r2.id}`, { method: "POST", body, headers: { Cookie: cookie } }), e);
    expect(await done.text()).toContain("Your site is updated");
    expect(await (await handle(new Request("https://site.example/"), e)).text()).toContain("Tea, on time.");
  });
});
