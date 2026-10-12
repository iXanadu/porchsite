// Entry addresses (SPEC §3): dateless streams, a chosen slug, and old addresses that redirect.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import { ApiError } from "../src/errors";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;
const who = "assistant:Helper";
const at = (path: string, init?: RequestInit) => handle(new Request(`https://site.example${path}`, init), e);

async function publish(ids: string[]) {
  const req = await approvals.request(db, who, ids, "");
  await approvals.decide(db, req.id, Object.fromEntries(ids.map((id) => [id, { decision: "approve" }])), "");
}

async function refused(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error("not refused");
}

async function signedIn(): Promise<string> {
  const token = "addresses-test-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await db.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

describe("entry addresses", () => {
  it("a stream with dated_addresses false gives new entries their title words alone", async () => {
    const s = await content.createItem(
      db,
      who,
      "site",
      { title: "Docs", streams: [{ id: "journal", title: "Log" }, { id: "guide", title: "Guide", dated_addresses: false }] },
      undefined,
    );
    expect((s.data.streams as { dated_addresses: boolean }[]).map((x) => x.dated_addresses)).toEqual([true, false]);
    const a = await content.createItem(db, who, "entry", { stream: "guide", title: "How it works", date: "2026-10-09" }, undefined);
    expect(a.slug).toBe("how-it-works");
    const b = await content.createItem(db, who, "entry", { stream: "journal", title: "How it works", date: "2026-10-09" }, undefined);
    expect(b.slug).toBe("2026-10-09-how-it-works");
    await publish([s.id, a.id, b.id]);
    expect((await at("/guide/how-it-works/")).status).toBe(200);
  });

  it("takes a chosen slug on create and keeps it out of the data", async () => {
    const a = await content.createItem(db, who, "entry", { title: "Prices for 2026", date: "2026-10-09", slug: "prices" }, undefined);
    expect(a.slug).toBe("prices");
    expect("slug" in a.data).toBe(false);
    const bad = await refused(content.createItem(db, who, "entry", { title: "Bad", date: "2026-10-09", slug: "Not OK" }, undefined));
    expect(bad.code).toBe("invalid");
    expect(JSON.stringify(bad.extra)).toContain('"field":"slug"');
  });

  it("refuses a slug another entry has", async () => {
    await content.createItem(db, who, "entry", { title: "Contact", date: "2026-10-09", slug: "contact" }, undefined);
    const b = await content.createItem(db, who, "entry", { title: "Reach us", date: "2026-10-09" }, undefined);
    const err = await refused(content.updateItem(db, who, b.id, b.version, { slug: "contact" }));
    expect(err.code).toBe("slug_taken");
    expect(err.message).toContain("contact");
    expect((await refused(content.createItem(db, who, "entry", { title: "Again", date: "2026-10-09", slug: "contact" }, undefined))).code).toBe("slug_taken");
  });

  it("an old address answers 301 once the changed one is live, and history shows the change", async () => {
    const a = await content.createItem(db, who, "entry", { title: "Opening hours", date: "2026-10-01" }, undefined);
    await publish([a.id]);
    const old = `/journal/${a.slug}/`;
    expect((await at(old)).status).toBe(200);
    const b = await content.updateItem(db, who, a.id, a.version, { slug: "hours" });
    expect(b.slug).toBe("hours");
    // Not live yet: the old address still shows the page.
    expect((await at(old)).status).toBe(200);
    await publish([a.id]);
    const r = await at(old);
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/journal/hours/");
    expect((await at(`/journal/${a.slug}`)).headers.get("location")).toBe("/journal/hours/");
    expect((await at(`/e/${a.slug}/`)).headers.get("location")).toBe("/journal/hours/");
    expect((await at("/journal/hours/")).status).toBe(200);
    const versions = await content.history(db, a.id);
    expect(versions[0].address_change).toEqual({ from: a.slug, to: "hours" });
    expect(versions[1].address_change).toBeUndefined();
    // A later title change keeps the chosen address.
    const c = await content.updateItem(db, who, a.id, b.version, { title: "When we're open" });
    expect(c.slug).toBe("hours");
  });

  it("the review page shows the address change", async () => {
    const a = await content.createItem(db, who, "entry", { title: "Menu today", date: "2026-10-02" }, undefined);
    await publish([a.id]);
    await content.updateItem(db, who, a.id, a.version, { slug: "menu" });
    const req = await approvals.request(db, who, [a.id], "");
    const page = await (await at(`/review/${req.id}`, { headers: { Cookie: await signedIn() } })).text();
    expect(page).toContain(`<p>Address changes from /journal/${a.slug}/ to /journal/menu/</p>`);
  });
});
