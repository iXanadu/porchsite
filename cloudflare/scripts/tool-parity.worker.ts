// Run only by vitest.parity.config.ts. Actual D1 + MCP handlers, fixed data.
import { env } from "cloudflare:workers";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { it, expect, vi } from "vitest";
import { validate } from "../src/content";
import { createServer } from "../src/mcp";
import { THEMES } from "../src/themes.gen";
import type { Env } from "../src/env";

type Case = { name: string; theme: string; sample: { site: Record<string, unknown>; items: { kind: string; slug?: string; data: Record<string, unknown> }[] }; home?: string };
const e = env as unknown as Env & { PARITY_CASES: string; PARITY_NOW: string; PARITY_OUTPUT: string };
const cases: Case[] = JSON.parse(e.PARITY_CASES);
const stamp = (n: number) => new Date(Date.UTC(2026, 9, 10, 12, 0, n)).toISOString();
function ordered(value: any): any {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}

it("compares all sample tool answers with deterministic fixtures", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(e.PARITY_NOW));
  try {
    for (const c of cases) {
      await e.DB.batch(["items", "live", "themes"].map(table => e.DB.prepare(`DELETE FROM ${table}`)));
      let theme = c.theme;
      if (c.home !== undefined) {
        theme = `parity-${c.name}`;
        const base = THEMES[c.theme];
        const look = { ...base, manifest: { ...base.manifest, name: theme }, pages: { ...base.pages, home: c.home } };
        await e.DB.prepare("INSERT INTO themes (name, version, package, sha256, installed_at, installed_by, source) VALUES (?, '1.0.0', ?, 'fixture', ?, 'assistant:test', 'private')").bind(theme, JSON.stringify(look), stamp(0)).run();
      }
      const rows = [{ id: "site", kind: "site", slug: null as string | null, data: validate("site", { ...c.sample.site, theme }) },
        ...c.sample.items.map((item, i) => ({ id: `i${i}`, kind: item.kind, slug: item.kind === "entry" ? item.slug ?? `item-${i}` : null, data: validate(item.kind, item.data) }))];
      await e.DB.batch(rows.flatMap((row, i) => [
        e.DB.prepare("INSERT INTO items (id, kind, slug, version, data, deleted, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 0, ?, ?)").bind(row.id, row.kind, row.slug, JSON.stringify(row.data), stamp(i), stamp(i)),
        e.DB.prepare("INSERT INTO live (item_id, kind, slug, version, data, published_at) VALUES (?, ?, ?, 1, ?, ?)").bind(row.id, row.kind, row.slug, JSON.stringify(row.data), stamp(i)),
      ]));
      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      const answers: Record<string, unknown> = {};
      try {
        const calls: [string, string, Record<string, unknown>][] = [
          ["site_check", "site_check", {}], ["site_state", "site_state", {}],
          ["site_state_full", "site_state", { full: true }],
          ["site_state_ids", "site_state", { ids: ["site", "i0"] }],
          ["site_state_empty", "site_state", { ids: [] }],
          ["site_state_unknown", "site_state", { ids: ["missing"] }],
        ];
        for (const [key, name, args] of calls) {
          const response = await transport.handleRequest(new Request("https://example.invalid/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
          expect(response.status).toBe(200);
          const rpc = await response.json() as any;
          answers[key] = { error: !!rpc.result.isError, value: JSON.parse(rpc.result.content[0].text) };
        }
      } finally { await server.close(); }
      // Vitest's snapshot bridge writes to the host, outside the Worker. These
      // are fresh temporary files, never committed snapshots or expectations.
      await expect(JSON.stringify(ordered(answers), null, 2) + "\n").toMatchFileSnapshot(`${e.PARITY_OUTPUT}/${c.name}.json`);
    }
  } finally { vi.useRealTimers(); }
});
