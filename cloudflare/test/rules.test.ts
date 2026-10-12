// The safety rules (spec §2), tested against the real D1 code paths.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import { ApiError } from "../src/errors";
import * as site from "../src/site";

const db = (env as unknown as { DB: D1Database }).DB;
const who = "assistant:test";
let n = 0;
const entry = (extra: Record<string, unknown> = {}) => ({
  title: `Entry ${++n}`,
  date: "2026-10-08",
  summary: "A test entry.",
  ...extra,
});

async function refused(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("versions, retries, guard, history", () => {
  it("refuses an update from an old version (S3)", async () => {
    const a = await content.createItem(db, who, "entry", entry(), undefined);
    await content.updateItem(db, who, a.id, 1, { summary: "Second." });
    expect((await refused(content.updateItem(db, who, a.id, 1, { summary: "Lost?" }))).code).toBe("version_conflict");
    expect((await refused(content.updateItem(db, who, a.id, 0, { summary: "Zero" }))).code).toBe("version_conflict");
    expect((await content.getItem(db, a.id)).data.summary).toBe("Second.");
  });

  it("returns the same item for a replayed create (S4)", async () => {
    const data = entry();
    const a = await content.createItem(db, who, "entry", data, "key-1");
    const b = await content.createItem(db, who, "entry", data, "key-1");
    expect(b.id).toBe(a.id);
    expect(b.replayed).toBe(true);
    expect((await refused(content.createItem(db, who, "entry", entry(), "key-1"))).code).toBe("idempotency_mismatch");
  });

  it("refuses secrets in drafts (S6)", async () => {
    const e = await refused(content.createItem(db, who, "entry", entry({ body: "password: hunter2xyz" }), undefined));
    expect(e.code).toBe("content_guard");
  });

  it("keeps every version and rolls back (S5)", async () => {
    const a = await content.createItem(db, who, "entry", entry(), undefined);
    const b = await content.updateItem(db, who, a.id, 1, { summary: "Changed." });
    const c = await content.rollback(db, who, a.id, 1, b.version);
    expect(c.version).toBe(3);
    expect(c.data.summary).toBe("A test entry.");
    expect((await content.history(db, a.id)).map((h) => h.action)).toEqual(["rollback", "update", "create"]);
  });

  it("reads a card's old `status` as its badge", async () => {
    const c = await content.createItem(db, who, "card", { name: "Old", description: "x", status: "Beta" }, undefined);
    expect(c.data.badge).toBe("Beta");
    expect(c.data.link).toBe("");
  });
});

describe("the owner's yes (S1, S2)", () => {
  it("publishes exactly the approved items and nothing else", async () => {
    const a = await content.createItem(db, who, "entry", entry({ title: "Approved one" }), undefined);
    const b = await content.createItem(db, who, "entry", entry({ title: "Left staged" }), undefined);
    const req = await approvals.request(db, who, [a.id], "test");
    let home = await (site.home(await site.liveView(db))).text();
    expect(home).not.toContain("Approved one");
    await approvals.decide(db, req.id, { [a.id]: { decision: "approve" } }, "");
    home = await (site.home(await site.liveView(db))).text();
    expect(home).toContain("Approved one");
    expect(home).not.toContain("Left staged");
    expect(b.id).toBeTruthy();
  });

  it("voids the request for an item edited after asking", async () => {
    const a = await content.createItem(db, who, "entry", entry({ title: "Edited later" }), undefined);
    const req = await approvals.request(db, who, [a.id], "");
    await content.updateItem(db, who, a.id, 1, { summary: "Changed after asking." });
    const got = await approvals.get(db, req.id);
    expect(got.items[0].status).toBe("superseded");
    expect(got.status).toBe("decided");
    const out = await approvals.decide(db, req.id, { [a.id]: { decision: "approve" } }, "");
    expect(out.published).toEqual([]);
    expect(await (site.home(await site.liveView(db))).text()).not.toContain("Edited later");
  });

  it("refuses drafts and unchanged items", async () => {
    const d = await content.createItem(db, who, "entry", entry({ status: "draft" }), undefined);
    expect((await refused(approvals.request(db, who, [d.id], ""))).code).toBe("draft");
    const a = await content.createItem(db, who, "entry", entry(), undefined);
    const req = await approvals.request(db, who, [a.id], "");
    await approvals.decide(db, req.id, { [a.id]: { decision: "approve" } }, "");
    expect((await refused(approvals.request(db, who, [a.id], ""))).code).toBe("nothing_to_approve");
  });

  it("a newer request takes the item out of an older one", async () => {
    const a = await content.createItem(db, who, "entry", entry(), undefined);
    const first = await approvals.request(db, who, [a.id], "");
    await approvals.request(db, who, [a.id], "again");
    expect((await approvals.get(db, first.id)).items[0].status).toBe("superseded");
  });
});
