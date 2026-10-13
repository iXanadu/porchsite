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
    expect(init.result.serverInfo.name).toBe("porchsite");
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

describe("image_add", () => {
  it("takes a picture as base64", async () => {
    const { create } = await import("../src/keys");
    const { token } = await create(e.DB, "Painter");
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 128, 0, 0, 1, 224, ...new Array(40).fill(0)]);
    const call = async (data: string) => json(await rpc(token, "tools/call", { name: "image_add", arguments: { data } }));
    const ok = await call(btoa(String.fromCharCode(...png)));
    const out = JSON.parse(ok.result.content[0].text);
    expect(out.image).toMatch(/^\/media\/[0-9a-f]{32}\.png$/);
    expect([out.width, out.height]).toEqual([640, 480]);
    const bad = await call("not base64!!");
    expect(bad.result.isError).toBe(true);
    expect(JSON.parse(bad.result.content[0].text).error).toBe("invalid");
    const notImage = await call(btoa("hello there"));
    expect(JSON.parse(notImage.result.content[0].text).error).toBe("not_an_image");
  });
});

describe("plain JSON", () => {
  it("answers a client that accepts only JSON with JSON, like the server edition", async () => {
    const { create } = await import("../src/keys");
    const { token } = await create(e.DB, "Script");
    const r = await go("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("application/json");
    const body = (await r.json()) as { id: number; result: { tools: unknown[] } };
    expect(body.id).toBe(7);
    expect(body.result.tools.length).toBeGreaterThan(10);
  });
});
