// Assistant keys (SPEC §4): the owner makes one on /review/assistants; an
// assistant sends it to /mcp as a bearer token and drafts like any other;
// revoked, it stops working. Port-matched: server/tests/app/test_web_keys.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as content from "../src/content";
import type { Env } from "../src/env";
import worker from "../src/index";

const e = env as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const go = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://site.example${path}`, init), e, ctx);

async function signedIn(): Promise<string> {
  const token = "keys-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await e.DB.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await e.DB.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}
const rpc = (key: string, method: string, params: unknown = {}) =>
  go("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
const json = async (r: Response) => {
  const t = await r.text();
  return JSON.parse(t.trim().startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5));
};

describe("assistant keys", () => {
  it("draft like a connected assistant until revoked", async () => {
    const owner = await signedIn();
    const page = await (await go("/review/assistants", { headers: { Cookie: owner } })).text();
    expect(page).toContain('<h1 style="margin-top:36px">Assistant keys</h1>');
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1];
    const form = (fields: Record<string, string>) =>
      go("/review/assistants", { method: "POST", headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...fields }) });
    const made = await (await form({ key_name: "Muse", make_key: "1" })).text();
    const key = /<p class="value"><b>(psk_[A-Za-z0-9_-]+)<\/b>/.exec(made)![1];
    expect(made).toContain("Copy it now");

    const init = await json(await rpc(key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    expect(init.result.serverInfo.name).toBe("sitekeeper");
    const made2 = await json(await rpc(key, "tools/call", { name: "item_create", arguments: { kind: "note", data: { text: "Hello from a key.", date: "2026-10-12" } } }));
    const item = JSON.parse(made2.result.content[0].text);
    const hist = await content.history(e.DB, item.id);
    expect(hist[0].actor).toBe("assistant:Muse");

    const after = await (await go("/review/assistants", { headers: { Cookie: owner } })).text();
    expect(after).toContain("last used ");
    const kid = /name="revoke_key" value="([^"]+)"/.exec(after)![1];
    await form({ revoke_key: kid });
    const refused = await rpc(key, "tools/list");
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: string }).error).toBe("invalid_token");
    expect((await rpc("psk_nope", "tools/list")).status).toBe(401);
  });
});
