// The owner's writing desk (spec §5): the owner writes and publishes directly, through the same safety rules.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;
const who = "assistant:test";
const at = (path: string, init?: RequestInit) => handle(new Request(`https://site.example${path}`, init), e);

async function signedIn(): Promise<string> {
  const token = "desk-test-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await db.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)![1];

function post(path: string, cookie: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return at(path, { method: "POST", body, headers: { Cookie: cookie } });
}

describe("writing desk", () => {
  it("is the owner's only", async () => {
    const r = await at("/review/write");
    expect(r.status).toBe(303);
    expect((await post("/review/write/new", "", { title: "Sneaky", date: "2026-10-01", action: "publish" })).status).toBe(303);
    expect((await content.allItems(db)).length).toBe(0);
  });

  it("writes a draft, previews it, and publishes it at once", async () => {
    const s = await content.createItem(db, who, "site", { title: "Kettle", streams: [{ id: "journal", title: "Journal" }, { id: "letters", title: "Notes" }] }, undefined);
    const r = await approvals.request(db, who, [s.id], "");
    await approvals.decide(db, r.id, { [s.id]: { decision: "approve" } }, "");
    const cookie = await signedIn();
    const blank = await (await at("/review/write/new", { headers: { Cookie: cookie } })).text();
    expect(blank).toContain("<h1>Write something new</h1>");
    expect(blank).toContain('<option value="journal" selected>Journal</option><option value="letters">Notes</option>');
    expect(blank).toContain("Save as a draft");
    const saved = await post("/review/write/new", cookie, { csrf: csrfOf(blank), stream: "letters", title: "Dear reader", summary: "A first letter.", date: "2026-10-05", tags: "tea, mornings", body: "Hello.\r\n\r\nMore soon.", action: "save" });
    expect(saved.status).toBe(303);
    const id = /\/review\/write\/(ent_[0-9a-f]+)\?saved=1$/.exec(saved.headers.get("location")!)![1];
    const item = await content.getItem(db, id);
    expect(item.data).toMatchObject({ stream: "letters", title: "Dear reader", status: "draft", tags: ["tea", "mornings"], body: "Hello.\n\nMore soon." });
    expect((await content.history(db, id))[0].actor).toBe("owner");
    const edit = await (await at(`/review/write/${id}?saved=1`, { headers: { Cookie: cookie } })).text();
    expect(edit).toContain('<span class="tag">draft</span>');
    expect(edit).toContain('<p class="ok">Saved.</p>');
    expect(edit).toContain('<option value="letters" selected>Notes</option>');
    // The preview shows the draft as its page; the public site doesn't have it.
    const preview = await (await at(`/review/write/${id}/preview`, { headers: { Cookie: cookie } })).text();
    expect(preview).toContain("Preview: not live until you publish.");
    expect(preview).toContain("<h1>Dear reader</h1>");
    expect((await at(`/letters/${item.slug}/`)).status).toBe(404);
    const done = await post(`/review/write/${id}`, cookie, { csrf: csrfOf(edit), version: String(item.version), stream: "letters", title: "Dear reader", summary: "A first letter.", date: "2026-10-05", tags: "tea mornings", body: "Hello.\n\nMore soon.", action: "publish" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`https://site.example/review/write?published=${id}`);
    expect(await (await at(`/letters/${item.slug}/`)).text()).toContain("Dear reader");
    const pub = await db.prepare("SELECT actor, approval_id, items, note FROM publishes ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>();
    expect(pub).toMatchObject({ actor: "owner", approval_id: null, note: "published by the owner from the writing desk" });
    // Saved (version 2), marked ready (3), published at exactly that version.
    expect(JSON.parse(String(pub!.items))).toEqual([{ id, version: item.version + 2 }]);
    const index = await (await at(`/review/write?published=${id}`, { headers: { Cookie: cookie } })).text();
    expect(index).toContain("<p class=\"ok\">Published. It's live on the site.</p>");
    expect(index).toContain('<span class="tag">live</span><h2 style="margin-top:8px">Dear reader</h2><div class="meta">2026-10-05 · Notes #tea #mornings</div>');
  });

  it("shows the assistant's drafts for the owner to finish", async () => {
    const a = await content.createItem(db, who, "entry", { title: "From the assistant", date: "2026-10-06", summary: "Ready.", status: "ready" }, undefined);
    const req = await approvals.request(db, who, [a.id], "");
    const d = await content.createItem(db, who, "entry", { title: "Half done", date: "2026-10-07", status: "draft" }, undefined);
    const cookie = await signedIn();
    const index = await (await at("/review/write", { headers: { Cookie: cookie } })).text();
    expect(index).toContain('<span class="tag">draft</span><h2 style="margin-top:8px">Half done</h2>');
    expect(index).toContain('<span class="tag">ready, not live</span><h2 style="margin-top:8px">From the assistant</h2>');
    expect(index.indexOf("Half done")).toBeLessThan(index.indexOf("From the assistant"));
    const edit = await (await at(`/review/write/${a.id}`, { headers: { Cookie: cookie } })).text();
    const done = await post(`/review/write/${a.id}`, cookie, { csrf: csrfOf(edit), version: String(a.version), stream: "", title: "From the assistant", summary: "Ready.", date: "2026-10-06", tags: "", body: "", action: "publish" });
    expect(done.status).toBe(303);
    // Saved with nothing changed but the stream's spelling, then published at that version.
    const now = await content.getItem(db, a.id);
    expect((await db.prepare("SELECT version FROM live WHERE item_id = ?").bind(a.id).first<{ version: number }>())!.version).toBe(now.version);
    expect((await approvals.get(db, req.id)).items[0].status).toBe("superseded");
    expect(d.version).toBe(1);
    // The owner publishing the very version a request names settles the request.
    const b = await content.createItem(db, who, "entry", { title: "Asked for", date: "2026-10-06" }, undefined);
    const asked = await approvals.request(db, who, [b.id], "");
    expect(await approvals.publishNow(db, [{ id: b.id, version: b.version }], "")).toEqual([b.id]);
    expect((await approvals.get(db, asked.id)).items[0].status).toBe("published");
    expect((await approvals.get(db, asked.id)).status).toBe("decided");
  });

  it("refuses a stale form, an old version and guarded text, keeping what was typed", async () => {
    const cookie = await signedIn();
    const item = (await content.allItems(db)).find((i) => i.data.title === "Half done")!;
    const edit = await (await at(`/review/write/${item.id}`, { headers: { Cookie: cookie } })).text();
    const fields = { version: String(item.version), stream: "", title: "Half done", summary: "", date: "2026-10-07", tags: "", body: "Still writing.", action: "save" };
    const stale = await post(`/review/write/${item.id}`, cookie, { ...fields, csrf: "nope" });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain("This form expired. Try again.");
    await content.updateItem(db, who, item.id, item.version, { summary: "The assistant got here first." });
    const old = await post(`/review/write/${item.id}`, cookie, { ...fields, csrf: csrfOf(edit) });
    expect(old.status).toBe(409);
    const oldText = await old.text();
    expect(oldText).toContain("This entry changed since you opened it");
    expect(oldText).toContain(">Still writing.</textarea>");
    const fresh = await content.getItem(db, item.id);
    const guarded = await post(`/review/write/${item.id}`, cookie, { ...fields, version: String(fresh.version), body: "password: hunter2hunter2", csrf: csrfOf(edit) });
    expect(guarded.status).toBe(422);
    expect(await guarded.text()).toContain("This looks like it contains a password.");
    const bad = await post(`/review/write/${item.id}`, cookie, { ...fields, version: String(fresh.version), date: "soon", csrf: csrfOf(edit) });
    expect(await bad.text()).toContain("date: must be a date written YYYY-MM-DD");
    expect((await content.getItem(db, item.id)).version).toBe(fresh.version);
  });
});
