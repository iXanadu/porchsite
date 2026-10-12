// PKCE (S256) from every app, confidential ones too (SPEC Assistants).
// Port-matched: server/tests/app/test_web_oauth.py (PKCE refusals).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";

const e = env as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const go = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://site.example${path}`, init), e, ctx);

async function signedIn(): Promise<string> {
  const token = "pkce-test-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await e.DB.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await e.DB.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

describe("PKCE", () => {
  it("refuses a confidential app that sends no code_challenge, back at its own address", async () => {
    const reg = await go("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Server app", redirect_uris: ["https://app.example.com/cb"], token_endpoint_auth_method: "client_secret_basic" }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const cookie = await signedIn();
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://app.example.com/cb", state: "s1", scope: "site:draft" });
    const r = await go(`/authorize?${q}`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(302);
    const back = new URL(r.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe("https://app.example.com/cb");
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe("s1");

    q.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    q.set("code_challenge_method", "S256");
    const ok = await go(`/authorize?${q}`, { headers: { Cookie: cookie } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Let Server app work on your site?");
  });
});
