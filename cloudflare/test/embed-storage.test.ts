import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import * as content from "../src/content";
import * as approvals from "../src/approvals";
import * as history from "../src/history";
import { migrateSources } from "../src/embed-storage";
import { SiteData } from "../src/models";
import type { Env } from "../src/env";

const db = (env as unknown as Env).DB;
const A = "https://example.com", B = "https://video.example";
const origin = "https://site.example";
beforeEach(async () => {
  await db.batch(["site_embed_sources", "approvals", "publishes", "live", "revisions", "items", "idempotency"].map(t => db.prepare(`DELETE FROM ${t}`)));
});
async function publish(item: content.Item) {
  const a = await approvals.request(db, "assistant:test", [item.id], "");
  await approvals.decide(db, a.id, { [item.id]: { decision: "approve" } }, "", origin);
}
async function cleanPayloads() {
  const { results } = await db.prepare("SELECT data FROM items WHERE id = 'site' UNION ALL SELECT data FROM revisions WHERE item_id = 'site' UNION ALL SELECT data FROM live WHERE item_id = 'site'").all<{ data: string }>();
  for (const r of results) {
    expect(JSON.parse(r.data)).not.toHaveProperty("embed_sources");
    expect(SiteData.safeParse(JSON.parse(r.data)).success).toBe(true);
  }
}

it("keeps raw snapshots legacy-safe while versions, approval and history retain their source lists", async () => {
  const one = await content.createItem(db, "assistant:test", "site", { embed_sources: [A] }, undefined);
  await cleanPayloads();
  expect((await content.siteData(db, true)).embed_sources).toEqual([]);
  await publish(one);
  const first = (await history.publishes(db))[0].id;
  expect((await content.siteData(db, true)).embed_sources).toEqual([A]);
  const two = await content.updateItem(db, "assistant:test", "site", 1, { embed_sources: [B] });
  expect((await content.getItem(db, "site")).data.embed_sources).toEqual([B]);
  expect((await content.siteData(db, true)).embed_sources).toEqual([A]);
  await publish(two);
  expect((await content.siteData(db, true)).embed_sources).toEqual([B]);
  expect((await history.plan(db, first)).changes[0].data.embed_sources).toEqual([A]);
  await history.revert(db, first, "", origin);
  expect((await content.siteData(db, true)).embed_sources).toEqual([A]);
  const current = await content.getItem(db, "site");
  const restored = await content.rollback(db, "assistant:test", "site", 2, current.version);
  expect(restored.data.embed_sources).toEqual([B]);
  expect((await content.siteData(db, true)).embed_sources).toEqual([A]);
  await publish(restored);
  expect((await content.siteData(db, true)).embed_sources).toEqual([B]);
  await cleanPayloads();
});

it("repairs all legacy snapshots without promoting a staged list or changing approval versions", async () => {
  const one = await content.createItem(db, "assistant:test", "site", { embed_sources: [A] }, undefined);
  await publish(one);
  const two = await content.updateItem(db, "assistant:test", "site", 1, { embed_sources: [B] });
  const a = await approvals.request(db, "assistant:test", ["site"], "");
  await db.batch([
    db.prepare("DELETE FROM site_embed_sources"),
    db.prepare("UPDATE items SET data = ? WHERE id = 'site'").bind(JSON.stringify(two.data)),
    db.prepare("UPDATE revisions SET data = ? WHERE item_id = 'site' AND version = 1").bind(JSON.stringify(one.data)),
    db.prepare("UPDATE revisions SET data = ? WHERE item_id = 'site' AND version = 2").bind(JSON.stringify(two.data)),
    db.prepare("UPDATE live SET data = ? WHERE item_id = 'site'").bind(JSON.stringify(one.data)),
  ]);
  // A different content write also repairs the poisoned live snapshot.
  await content.createItem(db, "assistant:test", "note", { text: "A note", date: "2026-10-15" }, undefined);
  await cleanPayloads();
  expect((await content.siteData(db, true)).embed_sources).toEqual([A]);
  expect((await content.siteData(db, false)).embed_sources).toEqual([B]);
  expect((await approvals.get(db, a.id)).items[0]).toMatchObject({ version: 2, status: "pending" });
  expect((await db.prepare("SELECT version, approved FROM site_embed_sources ORDER BY version").all()).results).toEqual([{ version: 1, approved: 1 }, { version: 2, approved: 0 }]);
  await migrateSources(db);
  await approvals.decide(db, a.id, { site: { decision: "approve" } }, "", origin);
  expect((await content.siteData(db, true)).embed_sources).toEqual([B]);
  await cleanPayloads();
});

it.each(["request", "decide"])("repairs legacy inline lists through approval %s without any content write", async (action) => {
  const one = await content.createItem(db, "assistant:test", "site", { embed_sources: [A] }, undefined);
  await publish(one);
  const two = await content.updateItem(db, "assistant:test", "site", 1, { embed_sources: [B] });
  let pending = await approvals.request(db, "assistant:test", ["site"], "");
  // Reconstruct the previous inline-storage format, including live and pending versions.
  await db.batch([
    db.prepare("DELETE FROM site_embed_sources"),
    db.prepare("UPDATE items SET data = ? WHERE id = 'site'").bind(JSON.stringify(two.data)),
    db.prepare("UPDATE revisions SET data = ? WHERE item_id = 'site' AND version = 1").bind(JSON.stringify(one.data)),
    db.prepare("UPDATE revisions SET data = ? WHERE item_id = 'site' AND version = 2").bind(JSON.stringify(two.data)),
    db.prepare("UPDATE live SET data = ? WHERE item_id = 'site'").bind(JSON.stringify(one.data)),
  ]);
  // A read does not repair; no content write or direct migration follows this seed.
  await content.siteData(db, true);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM site_embed_sources").first("n")).toBe(0);
  if (action === "request") {
    pending = await approvals.request(db, "assistant:test", ["site"], "");
    await cleanPayloads();
    const { results } = await db.prepare("SELECT version, sources, approved FROM site_embed_sources ORDER BY version").all<{version:number;sources:string;approved:number}>();
    expect(results.map(r=>({...r,sources:JSON.parse(r.sources)}))).toEqual([
      {version:1,sources:[A],approved:1}, {version:2,sources:[B],approved:0},
    ]);
    expect((await approvals.get(db, pending.id)).items[0]).toMatchObject({version:2,status:"pending"});
  }
  await approvals.decide(db, pending.id, {site:{decision:"approve"}}, "", origin);
  await cleanPayloads();
  expect((await content.siteData(db, true)).embed_sources).toEqual([B]);
  const { results } = await db.prepare("SELECT version, sources, approved FROM site_embed_sources ORDER BY version").all<{version:number;sources:string;approved:number}>();
  expect(results.map(r=>({...r,sources:JSON.parse(r.sources)}))).toEqual([
    {version:1,sources:[A],approved:1}, {version:2,sources:[B],approved:1},
  ]);
});

it("an old bundle cannot approve an unseen sidecar by copying raw staged JSON to live", async () => {
  const one = await content.createItem(db, "assistant:test", "site", { embed_sources: [A] }, undefined);
  await publish(one);
  await content.updateItem(db, "assistant:test", "site", 1, { embed_sources: [B] });
  await db.prepare("UPDATE live SET data = (SELECT data FROM items WHERE id = 'site'), version = 2 WHERE item_id = 'site'").run();
  expect((await content.siteData(db, true)).embed_sources).toEqual([]);
  const three = await content.updateItem(db, "assistant:test", "site", 2, { title: "Changed" });
  await publish(three);
  expect((await content.siteData(db, true)).embed_sources).toEqual([B]);
  await expect(content.updateItem(db, "assistant:test", "site", 2, { embed_sources: [A] })).rejects.toMatchObject({ code: "version_conflict" });
  expect((await content.siteData(db, true)).embed_sources).toEqual([B]);
  await cleanPayloads();
});

it("refuses conflicting legacy versions without stripping evidence or widening authority", async () => {
  const one = await content.createItem(db, "assistant:test", "site", { embed_sources: [A] }, undefined);
  await publish(one);
  await db.batch([
    db.prepare("DELETE FROM site_embed_sources"),
    db.prepare("UPDATE items SET data = ? WHERE id = 'site'").bind(JSON.stringify({ ...one.data, embed_sources: [B] })),
    db.prepare("UPDATE live SET data = ? WHERE item_id = 'site'").bind(JSON.stringify(one.data)),
  ]);
  await expect(migrateSources(db)).rejects.toMatchObject({ code: "source_conflict" });
  expect((await content.siteData(db, true)).embed_sources).toEqual([A]);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM site_embed_sources").first("n")).toBe(0);
});
