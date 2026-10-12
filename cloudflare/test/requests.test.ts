// Theme requests, end to end: a site files one, the queue checks it came
// from that site, a curator groups and answers it, the site sees the answer.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleBoard } from "../downloads/board/index";
import type { Env } from "../src/env";
import * as requests from "../src/requests";
import { handle } from "../src/routes";
import { applyBoardSchema } from "./board-schema";

const e = env as unknown as Env;
const db = e.DB;
const KEY = "k".repeat(40);
const board = { DB: db, CURATOR_KEY: KEY, ASSETS: {} as Fetcher };

// The queue reaches the site through the site's own handler; the site reaches the queue through the board's.
const toSite = (url: string) => handle(new Request(url), e);
const toQueue = async (url: string, init?: RequestInit) => (await handleBoard(new Request(url, init), board, toSite)) ?? new Response("", { status: 404 });
const curator = (path: string, body?: unknown) =>
  toQueue(`https://get.porchsite.dev${path}`, body ? { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) } : { headers: { Authorization: `Bearer ${KEY}` } });

describe("theme requests", () => {
  beforeEach(async () => {
    await applyBoardSchema(db);
  });

  it("files privately, gets grouped and answered, and the site hears", async () => {
    const filed = await requests.file(db, "https://bakery.example", "assistant:test", { type: "business", title: "Bakery with hours", description: "Opening hours, a weekly specials list.", examples: [] }, toQueue);
    expect(filed.status).toBe("open");

    // Only the curator sees the words.
    expect((await toQueue("https://get.porchsite.dev/curator/requests")).status).toBe(401);
    const q = (await (await curator("/curator/requests")).json()) as { requests: { id: string; title: string; origin?: string }[] };
    expect(q.requests.map((r) => r.title)).toContain("Bakery with hours");
    expect(q.requests[0].origin).toBeUndefined();

    await curator(`/curator/requests/${filed.id}`, { action: "group", group: "small-business-hours" });
    const g = (await (await curator("/curator/groups")).json()) as { groups: { name: string; sites: number }[] };
    expect(g.groups[0]).toMatchObject({ name: "small-business-hours", sites: 1 });
    expect((await requests.mine(db, toQueue))[0]).toMatchObject({ id: filed.id, status: "open" });

    await curator("/curator/groups/small-business-hours", { action: "answer", theme: "shopfront" });
    expect((await requests.mine(db, toQueue))[0]).toMatchObject({ id: filed.id, status: "answered", theme: "shopfront" });

    // The public status says nothing about what was asked.
    const pub = await (await toQueue(`https://get.porchsite.dev/requests/status?ids=${filed.id}`)).text();
    expect(pub).not.toContain("Bakery");
  });

  it("shares a look this site made, re-checked by the queue, reviewed by the curator", async () => {
    const { THEMES } = await import("../src/themes.gen");
    const themes = await import("../src/themes");
    const sample = JSON.parse((await import("../../themes/product-page/sample.json?raw")).default);
    const b = THEMES["product-page"];
    await themes.create(db, { manifest: { ...b.manifest, name: "tea-house" }, sample, pages: b.pages, partials: b.partials, css: b.static["site.css"] }, "assistant:test", async () => Response.json({ themes: [] }));
    const s = await requests.submit(db, "https://bakery.example", "assistant:test", "tea-house", "For tea rooms: a menu-led front page.", toQueue);
    expect(s.status).toBe("new");
    const list = (await (await curator("/curator/submissions")).json()) as { submissions: { id: string; name: string }[] };
    expect(list.submissions.map((x) => x.name)).toContain("tea-house");
    const one = (await (await curator(`/curator/submissions/${s.id}`)).json()) as { package: { manifest: { name: string } } };
    expect(one.package.manifest.name).toBe("tea-house");
    await curator(`/curator/submissions/${s.id}`, { action: "reject", note: "Too close to product-page." });
    expect((await requests.mySubmissions(db, toQueue))[0]).toMatchObject({ name: "tea-house", status: "rejected", note: "Too close to product-page." });
    // Only the site's own looks can be shared.
    expect((await requests.submit(db, "https://bakery.example", "assistant:test", "product-page", "x".repeat(20), toQueue).catch((x) => x)).code).toBe("no_such_look");
  });

  it("refuses a request the site didn't send", async () => {
    const r = await toQueue("https://get.porchsite.dev/requests", {
      method: "POST",
      body: JSON.stringify({ origin: "https://bakery.example/", nonce: "x".repeat(24), type: "business", title: "Spam", description: "Buy things now please" }),
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe("not_proven");
  });
});

describe("the old downloads address", () => {
  it("sends reads with 301 and the rest with 308, keeping the path; the curator's calls stay", async () => {
    const { movedFrom } = await import("../downloads/board/index");
    const get = movedFrom(new Request("https://get.sitekeeper.dev/v/2026.10.12-2ce79ce/files.json?x=1"))!;
    expect(get.status).toBe(301);
    expect(get.headers.get("Location")).toBe("https://get.porchsite.dev/v/2026.10.12-2ce79ce/files.json?x=1");
    const post = movedFrom(new Request("https://get.sitekeeper.dev/requests", { method: "POST", body: "{}" }))!;
    expect(post.status).toBe(308);
    expect(post.headers.get("Location")).toBe("https://get.porchsite.dev/requests");
    expect(movedFrom(new Request("https://get.sitekeeper.dev/curator/requests"))).toBeNull();
    expect(movedFrom(new Request("https://get.porchsite.dev/latest.json"))).toBeNull();
  });
});
