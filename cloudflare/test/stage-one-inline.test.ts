// Inline feature bodies are readable without a link to an entry page.
// Port-matched: server/tests/app/test_stage_one_inline.py.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as keys from "../src/keys";
import { THEMES } from "../src/themes.gen";

it("counts a full inline feature body, but not a title or summary alone", async () => {
  const e = env as unknown as Env;
  const db = e.DB;
  const who = "assistant:test";
  const s = await content.createItem(db, who, "site", { title: "Test", theme: "product-page", streams: [{ id: "front", title: "Overview", layout: "feature" }], sections: ["front"] }, undefined);
  const feature = await content.createItem(db, who, "entry", { title: "Feature", summary: "Short summary", body: "The complete inline feature body.", stream: "front", slug: "overview", date: "2026-10-15", status: "ready" }, undefined);
  const publish = async (ids: string[]) => {
    const request = await approvals.request(db, who, ids, "");
    await approvals.decide(db, request.id, Object.fromEntries(ids.map(id => [id, { decision: "approve" as const }])), "");
  };
  await publish([s.id, feature.id]);
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const { token } = await keys.create(db, "Test");
  const check = async () => {
    const response = await worker.fetch(new Request("https://site.example/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "site_check", arguments: { deep: true } } }) }), e, ctx);
    expect(response.status).toBe(200);
    const rpc = await response.json() as any;
    expect(rpc.result.isError).not.toBe(true);
    return JSON.parse(rpc.result.content[0].text);
  };
  const home = await (await worker.fetch(new Request("https://site.example/"), e, ctx)).text();
  expect(home).toContain("The complete inline feature body.");
  expect(home).not.toContain('href="/front/overview/"');
  expect(home).not.toContain("porchsite-check-");
  const inline = await check();
  expect(inline.ok).toBe(true);
  expect(inline.unreachable).toEqual([]);
  const homeAfterCheck = await (await worker.fetch(new Request("https://site.example/"), e, ctx)).text();
  expect(homeAfterCheck).toBe(home);
  expect(homeAfterCheck).not.toContain("porchsite-check-");

  // The same feature layout is insufficient when its body is not emitted.
  const base = THEMES["product-page"];
  const look = { ...base, manifest: { ...base.manifest, name: "summary-only" }, pages: { ...base.pages, home: '<html><body>{{#sections}}{{#latest}}<h1>{{title}}</h1><p>{{summary}}</p>{{/latest}}{{/sections}}</body></html>' } };
  await db.prepare("INSERT INTO themes (name, version, package, sha256, installed_at, installed_by, source) VALUES (?, ?, ?, ?, ?, ?, 'private')").bind("summary-only", "1.0.0", JSON.stringify(look), "fixture", "2026-10-15", who).run();
  await content.updateItem(db, who, s.id, 1, { theme: "summary-only" });
  await publish([s.id]);
  const summaryHome = await (await worker.fetch(new Request("https://site.example/"), e, ctx)).text();
  expect(summaryHome).toContain("Short summary");
  expect(summaryHome).not.toContain("The complete inline feature body.");
  const omitted = await check();
  expect(omitted.ok).toBe(false);
  expect(omitted.unreachable.map((x: any) => x.id)).toEqual([feature.id]);
});
