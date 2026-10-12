// A refusal inside an owner page (an unknown id, a link that's used up, a
// bad request) is the owner's page with the refusal's status, never a 500.
// Port-matched: server/tests/app/test_web_owner_refusals.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;
const at = (path: string, init?: RequestInit) => handle(new Request(`https://site.example${path}`, init), e);

async function signedIn(): Promise<string> {
  const token = "refusals-test-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await db.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)![1];
const ERROR_PAGE = "<title>Problem</title>";
const ERROR_H1 = "<h1>Something's wrong</h1>";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("owner pages refuse with the owner's page", () => {
  it("shows the error page, with the refusal's status, for every owner route given an unknown id", async () => {
    const cookie = await signedIn();
    const csrf = csrfOf(await (await at("/review/passkeys", { headers: { Cookie: cookie } })).text());
    const cases: [string, string, Record<string, string> | null][] = [
      ["GET", "/review/req_unknown00", null],
      ["POST", "/review/req_unknown00", { csrf, all: "approve" }],
      ["POST", "/review/req_unknown00", { csrf: "stale" }],
      ["GET", "/review/req_unknown00/preview", null],
      ["GET", "/review/history/999", null],
      ["POST", "/review/history/999", { csrf, note: "" }],
      ["POST", "/review/history/999", { csrf: "stale" }],
      ["GET", "/review/write/en_deadbeef", null],
      ["POST", "/review/write/en_deadbeef", { csrf, action: "save", title: "x", date: "2026-10-01" }],
      ["GET", "/review/write/en_deadbeef/preview", null],
    ];
    for (const [method, path, fields] of cases) {
      const r = await at(path, { method, headers: { Cookie: cookie }, body: fields ? form(fields) : undefined });
      const body = await r.text();
      expect([method, path, r.status]).toEqual([method, path, 404]);
      expect(body).toContain(ERROR_PAGE);
      expect(body).toContain(ERROR_H1);
    }
  });

  it("answers a used-up link with the link page and 410", async () => {
    for (const path of ["/upload/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "/passkey/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
      const r = await at(path);
      expect([path, r.status]).toEqual([path, 410]);
      const body = await r.text();
      expect(body).toContain("<title>Link used</title>");
      expect(body).toContain("<h1>This link has been used or has expired</h1>");
    }
    const sent = await at("/upload/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", { method: "POST", body: form({ alt: "x" }) });
    expect(sent.status).toBe(410);
    expect(await sent.text()).toContain("<title>Link used</title>");
  });

  it("answers a bad connect request with the Can't connect page and 400", async () => {
    const cookie = await signedIn();
    // Through the whole Worker: the OAuth provider hands /authorize its helpers.
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const r = await worker.fetch(new Request("https://site.example/authorize?response_type=code", { headers: { Cookie: cookie } }), e, ctx);
    expect(r.status).toBe(400);
    const body = await r.text();
    expect(body).toContain("<title>Can&#39;t connect</title>");
  });
});
