// Connecting an assistant end to end through the whole Worker: register, the
// owner allows it at /authorize, the code becomes a token, and the token opens
// /mcp. Port-matched: server/tests/app/test_web_oauth.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";

const e = env as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const go = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://site.example${path}`, init), e, ctx);
const REDIRECT = "https://app.example.com/cb";
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function signedIn(): Promise<string> {
  const token = "consent-test-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  await e.DB.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await e.DB.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(b64url(d)).run();
  return `__Host-sk_owner=${token}`;
}

describe("connecting an assistant", () => {
  it("registers, is allowed by the owner, trades the code for a token, and reaches /mcp", async () => {
    const reg = await go("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Desk App", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, state: "s1", scope: "site:draft", code_challenge: challenge, code_challenge_method: "S256" });

    // Not claimed yet: no connecting, and it says why (not the setup form).
    const early = await go(`/authorize?${q}`);
    expect(early.status).toBe(409);
    expect(await early.text()).toContain("Not claimed yet");
    const owner = await signedIn();
    // Claimed but not signed in: off to sign in first.
    expect((await go(`/authorize?${q}`)).status).toBe(303);
    const page = await go(`/authorize?${q}`, { headers: { Cookie: owner } });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("Let Desk App work on your site?");
    const handle = /name="handle" value="([^"]+)"/.exec(text)![1];
    const consent = (page.headers.get("Set-Cookie") ?? "").split(";")[0];

    const form = new URLSearchParams({ handle, label: "My helper", decision: "approve" });
    const done = await go("/authorize", { method: "POST", headers: { Cookie: `${owner}; ${consent}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    expect(done.status).toBe(302);
    const back = new URL(done.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("s1");
    const code = back.searchParams.get("code")!;

    const token = (body: Record<string, string>) =>
      go("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    expect((await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: "wrong".repeat(10) })).status).toBe(400);
    const tok = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: verifier });
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; token_type: string; scope: string };
    expect(t.token_type.toLowerCase()).toBe("bearer");

    const call = (auth: string) =>
      go("/mcp", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
      });
    expect((await call("Bearer nope")).status).toBe(401);
    const ok = await call(`Bearer ${t.access_token}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('"serverInfo"');
  });
});
