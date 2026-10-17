// A big decision says it's working and can't be sent twice; the review page
// loads in a fixed number of queries, however many items it has.
// Port-matched: server/tests/app/test_web_review_busy.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const who = "assistant:test";

async function signedIn(): Promise<string> {
  const token = "busy-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await e.DB.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await e.DB.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

// Counts the database round trips a request makes.
function counted(flag?:string): { env: Env; n: () => number } {
  let n = 0;
  const wrap = (s: any): any =>
    new Proxy(s, {
      get(st: any, m) {
        if (m === "__raw") return st;
        if (m === "bind") return (...a: unknown[]) => wrap(st.bind(...a));
        if (["first", "all", "run", "raw"].includes(String(m))) n++;
        const v = st[m];
        return typeof v === "function" ? v.bind(st) : v;
      },
    });
  const db = new Proxy(e.DB, {
    get(t: any, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
      if (k === "batch") return (b: any[]) => (n++, t.batch(b.map((x: any) => x.__raw ?? x)));
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { env: { ...e, SITE_URL: "https://site.example", PUBLIC_ARTIFACTS:flag, DB: db } as Env, n: () => n };
}

describe("big reviews", () => {
  it.each([undefined,"1"])("say they're working, and cost the same few queries for 1 item or 30 (prepared=%s)", async (flag) => {
    const cookie = await signedIn();
    const costs: number[] = [], decisions: number[] = [];
    for (const size of [1, 30]) {
      const ids: string[] = [];
      for (let i = 0; i < size; i++) ids.push((await content.createItem(e.DB, who, "card", { name: `C${size}-${i}`, description: "x", visibility: "public" }, undefined)).id);
      const r = await approvals.request(e.DB, who, ids, "");
      const c = counted(flag);
      const page = await (await handle(new Request(`https://site.example/review/${r.id}`, { headers: { Cookie: cookie } }), c.env)).text();
      costs.push(c.n());
      if (size === 30) {
        expect(page).toContain('data-busy="Publishing 30 changes… This can take a few seconds; keep this page open."');
        expect(page).toContain('data-busy="Saving your choices…"');
        expect(page).toContain("A big decision can take seconds");
      }
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1];
      const f = new FormData();
      f.set("csrf", csrf);
      f.set("all", "approve");
      const d = counted(flag);
      expect((await handle(new Request(`https://site.example/review/${r.id}`, { method: "POST", body: f, headers: { Cookie: cookie } }), d.env)).status).toBe(200);
      expect(d.n()).toBeLessThanOrEqual(12);
      decisions.push(d.n());
    }
    expect(costs[1]).toBe(costs[0]);
    expect(decisions[1]).toBe(decisions[0]);
  });
});
