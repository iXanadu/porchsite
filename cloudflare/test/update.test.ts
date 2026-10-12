// The update notice (SPEC §4 Updates): a daily look at latest.json, kept in KV, shown in
// site_state.update and as one quiet line on the owner's review pages. It never applies anything.
import { env } from "cloudflare:workers";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import { createServer } from "../src/mcp";
import { handle } from "../src/routes";
import * as update from "../src/update";
import casesFile from "../../spec/update-cases.json?raw";

const e = env as unknown as Env;
const CASES = JSON.parse(casesFile);
const DAY = update.DAY_MS;
const T0 = Date.parse("2026-10-21T09:00:00Z");

let calls: string[] = [];
let answer: () => Promise<Response> = async () => Response.json(CASES.latest);
const realFetch = update.runtime.fetch;
const realRelease = update.runtime.release;

beforeEach(async () => {
  calls = [];
  answer = async () => Response.json(CASES.latest);
  update.runtime.fetch = async (url) => {
    calls.push(url);
    return answer();
  };
  await e.OAUTH_KV.delete(update.CACHE_KEY);
});
afterEach(() => {
  update.runtime.fetch = realFetch;
  update.runtime.release = realRelease;
});

describe("update: what a running release lacks", () => {
  for (const c of CASES.cases) {
    it(c.name, async () => {
      update.runtime.release = c.running;
      const u = await update.check(e.OAUTH_KV, T0);
      expect(u).toEqual(c.update.available ? { ...c.update, how: update.HOW } : c.update);
      // A build that isn't a published release never asks.
      if (!update.RELEASE_ID.test(c.running)) expect(calls).toEqual([]);
    });
  }

  it("reads a latest.json without the release history", async () => {
    const c = CASES.latest_without_history;
    answer = async () => Response.json(c.latest);
    update.runtime.release = c.running;
    expect(await update.check(e.OAUTH_KV, T0)).toEqual({ ...c.update, how: update.HOW });
  });

  it("asks at most once a day, from the cache in between", async () => {
    update.runtime.release = "2026.10.15-bbbbbbb";
    expect((await update.check(e.OAUTH_KV, T0)).available).toBe(true);
    expect((await update.check(e.OAUTH_KV, T0 + DAY - 1)).available).toBe(true);
    expect(calls).toEqual([update.LATEST_URL]);
    expect(update.LATEST_URL).toBe("https://get.porchsite.dev/latest.json");
    // A day later it asks again, and hears the site is now current.
    answer = async () => Response.json({ ...CASES.latest, version: "2026.10.15-bbbbbbb", releases: CASES.latest.releases.slice(1) });
    expect(await update.check(e.OAUTH_KV, T0 + DAY)).toEqual({ available: false });
    expect(calls.length).toBe(2);
  });

  it("is silent when the fetch fails, keeps what it knew, and tries again the next day", async () => {
    update.runtime.release = "2026.10.15-bbbbbbb";
    answer = async () => {
      throw new Error("offline");
    };
    expect(await update.check(e.OAUTH_KV, T0)).toEqual({ available: false });
    expect(await update.check(e.OAUTH_KV, T0 + 1000)).toEqual({ available: false });
    expect(calls.length).toBe(1);
    answer = async () => Response.json(CASES.latest);
    expect((await update.check(e.OAUTH_KV, T0 + DAY)).available).toBe(true);
    // A later failure (a 500, or junk) keeps the last answer instead of forgetting it.
    answer = async () => new Response("nope", { status: 500 });
    expect((await update.check(e.OAUTH_KV, T0 + 2 * DAY)).available).toBe(true);
    answer = async () => new Response("{not json", { status: 200 });
    expect((await update.check(e.OAUTH_KV, T0 + 3 * DAY)).available).toBe(true);
    expect(calls.length).toBe(4);
  });
});

async function signedIn(): Promise<string> {
  const token = "update-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await e.DB.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await e.DB.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

describe("update: the owner's review pages", () => {
  const page = async (path: string) => (await handle(new Request(`https://site.example${path}`, { headers: { Cookie: await signedIn() } }), e)).text();
  const LINE = "A newer Porchsite is available (2026.10.20-ccccccc). Ask your assistant to update it.";

  it("show one quiet line when a newer release is out", async () => {
    update.runtime.release = "2026.10.20-ccccccc";
    expect(await page("/review")).not.toContain("newer Porchsite");
    await e.OAUTH_KV.delete(update.CACHE_KEY);
    update.runtime.release = "2026.10.15-bbbbbbb";
    const c = await content.createItem(e.DB, "assistant:test", "note", { text: "Open today.", date: "2026-10-07" }, undefined);
    const r = await approvals.request(e.DB, "assistant:test", [c.id], "");
    for (const html of [await page("/review"), await page(`/review/${r.id}`)]) {
      expect(html).toContain(`<p class="meta">${LINE}</p>`);
      expect(html).not.toContain("Security update");
      expect(html).not.toMatch(/<(button|form)[^>]*update/i);
    }
  });

  it("mark a security release clearly instead", async () => {
    update.runtime.release = "2026.10.12-aaaaaaa";
    const html = await page("/review");
    expect(html).toContain('<p class="warn"><b>Security update:</b> a newer Porchsite is available (2026.10.20-ccccccc). Ask your assistant to update it.</p>');
    expect(html).not.toContain(`<p class="meta">${LINE}</p>`);
  });

  it("say nothing on a dev build", async () => {
    update.runtime.release = "dev";
    expect(await page("/review")).not.toContain("Porchsite is available");
    expect(calls).toEqual([]);
  });
});

describe("update: site_state", () => {
  async function siteState() {
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "site_state", arguments: {} } }),
      }),
    );
    return ((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
  }

  it("carries update", async () => {
    update.runtime.release = "2026.10.12-aaaaaaa";
    const s = await siteState();
    expect(s.update).toEqual({ ...CASES.cases[2].update, how: "https://get.porchsite.dev/docs/install/#updating" });
    update.runtime.release = "dev";
    expect((await siteState()).update).toEqual({ available: false });
  });
});

describe("update: the guide it points to", () => {
  it("has an #updating anchor on /docs/install/", async () => {
    const { docBody } = await import("../downloads/board/index");
    const body = docBody("# Installing\n\n## Updating\n\ntext <b>\n\n## Updating the server edition\n");
    expect(body).toContain('<span id="updating">## Updating</span>');
    expect(body).toContain('<span id="updating-the-server-edition">## Updating the server edition</span>');
    expect(body).toContain("text &lt;b&gt;");
  });
});
