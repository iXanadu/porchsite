// site_state's small default and explicit full reads through real MCP.
// Port-matched: server/tests/app/test_stage_one_state.py.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as keys from "../src/keys";

const e = env as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
async function assistant() {
  const { token } = await keys.create(e.DB, "Test");
  return async (name: string, args: Record<string, unknown> = {}) => {
    const response = await worker.fetch(new Request("https://site.example/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), e, ctx);
    expect(response.status).toBe(200);
    const rpc = await response.json() as any;
    return { error: !!rpc.result.isError, value: JSON.parse(rpc.result.content[0].text) };
  };
}

it("returns a summary by default and preserves full item metadata on request", async () => {
  const call = await assistant();
  const made = await call("item_create", { kind: "entry", data: { title: "Summary target", date: "2026-10-15", body: "Full body text" } });
  expect(made.error).toBe(false);
  const summary = await call("site_state");
  expect(summary.error).toBe(false);
  const item = summary.value.items.find((x: any) => x.id === made.value.id);
  expect(item).toEqual({ id: made.value.id, kind: "entry", title: "Summary target", state: "new", version: 1 });
  const full = await call("site_state", { full: true });
  expect(full.error).toBe(false);
  const expanded = full.value.items.find((x: any) => x.id === made.value.id);
  const { next, ...original } = made.value;
  expect(expanded).toEqual(original);
  expect(full.value.release).toEqual(summary.value.release);
  expect(full.value.update).toEqual(summary.value.update);
});

it("returns full data only for requested ids", async () => {
  const call = await assistant();
  const first = await call("item_create", { kind: "note", data: { text: "Selected note", date: "2026-10-15" } });
  const second = await call("item_create", { kind: "note", data: { text: "Other note", date: "2026-10-15" } });
  expect(first.error || second.error).toBe(false);
  const result = await call("site_state", { ids: [first.value.id] });
  expect(result.error).toBe(false);
  expect(result.value.items.map((x: any) => x.id)).toEqual([first.value.id]);
  expect(result.value.items[0].data.text).toBe("Selected note");
  expect(result.value.items[0].pending_approval).toBeNull();
});

it("refuses an unknown id instead of silently returning unrelated items", async () => {
  const call = await assistant();
  const result = await call("site_state", { ids: ["ent_missing"] });
  expect(result.error).toBe(true);
  expect(result.value.error).toBe("no_such_item");
});


it("handles empty and duplicate ids, gives ids precedence over full and rejects a mixed unknown selection", async () => {
  const call = await assistant();
  const first = await call("item_create", { kind: "card", data: { name: "A card", description: "A description" } });
  const empty = await call("site_state", { full: true, ids: [] });
  expect(empty.error).toBe(false);
  expect(empty.value.items).toEqual([]);
  const selected = await call("site_state", { full: true, ids: [first.value.id, first.value.id] });
  expect(selected.error).toBe(false);
  expect(selected.value.items).toHaveLength(1);
  expect(selected.value.items[0].data.name).toBe("A card");
  const unknown = await call("site_state", { ids: [first.value.id, "missing"] });
  expect(unknown.error).toBe(true);
  expect(unknown.value.error).toBe("no_such_item");
  const summary = await call("site_state");
  expect(summary.value.items.find((x: any) => x.id === first.value.id)).toEqual({ id: first.value.id, kind: "card", title: "A card", state: "new", version: 1 });
});
