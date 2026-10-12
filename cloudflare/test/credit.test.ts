// Credit for a look's maker: an X handle and nothing else. Checked in the
// manifest, claimed when a look is shared, verified by the curator before it
// reaches the catalog, and removable without a new version of the look.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { creditInstructions, handleBoard } from "../downloads/board/index";
import { creditHtml } from "../demo/credit";
import { catalogEntry, packageManifest, parseCredits } from "../scripts/catalog.mjs";
import type { Env } from "../src/env";
import { createServer } from "../src/mcp";
import * as requests from "../src/requests";
import { handle } from "../src/routes";
import { rules } from "../src/themecheck";
import * as themes from "../src/themes";
import { THEMES } from "../src/themes.gen";
import creditsFile from "../../themes/credits.json?raw";
import { applyBoardSchema } from "./board-schema";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

const e = env as unknown as Env;
const db = e.DB;
const KEY = "c".repeat(40);
const board = { DB: db, CURATOR_KEY: KEY, ASSETS: {} as Fetcher };
const toSite = (url: string) => handle(new Request(url), e);
const toQueue = async (url: string, init?: RequestInit) => (await handleBoard(new Request(url, init), board, toSite)) ?? new Response("", { status: 404 });
const curator = (path: string, body?: unknown) =>
  toQueue(`https://get.porchsite.dev${path}`, body ? { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) } : { headers: { Authorization: `Bearer ${KEY}` } });

const base = THEMES["product-page"];
const authorProblems = (extra: Record<string, unknown>) =>
  rules("product-page", { ...base, manifest: { ...base.manifest, ...extra } } as any, { scripts: true }).filter((p) => /author|credit|X handle/.test(p));

describe("the manifest's author_x", () => {
  it("is an X handle without the @, and the only author field", () => {
    expect(authorProblems({})).toEqual([]);
    expect(authorProblems({ author_x: "maker_01" })).toEqual([]);
    expect(authorProblems({ author_x: "a".repeat(15) })).toEqual([]);
    for (const bad of ["@maker", "", "a".repeat(16), "has space", "dash-ed", 42]) expect(authorProblems({ author_x: bad })).toHaveLength(1);
    for (const other of ["author", "author_name", "author_email", "author_url", "email", "homepage", "website", "url", "creator", "twitter"]) {
      expect(authorProblems({ [other]: "x" }), other).toEqual([`${other}: credit is an X handle in author_x and nothing else (no names, emails or links)`]);
    }
  });

  it("isn't carried by any built-in look (credit for those is the catalog's)", () => {
    for (const [name, t] of Object.entries(THEMES)) expect(Object.keys(t.manifest).filter((k) => /author|email|url/i.test(k)), name).toEqual([]);
  });
});

describe("themes/credits.json and the catalog", () => {
  const names = Object.keys(THEMES);

  it("credits only looks that exist, each with an X handle", () => {
    const credits = parseCredits(creditsFile, names);
    for (const [name, x] of Object.entries(credits)) {
      expect(names).toContain(name);
      expect(x).toMatch(/^[A-Za-z0-9_]{1,15}$/);
    }
    expect(() => parseCredits('{"no-such-look": "maker"}', names)).toThrow(/isn't a look/);
    expect(() => parseCredits('{"portfolio": "@maker"}', names)).toThrow(/X handle/);
    expect(() => parseCredits('{"portfolio": {"name": "A Person"}}', names)).toThrow(/X handle/);
    expect(() => parseCredits("[]", names)).toThrow(/object/);
    expect(() => parseCredits("{", names)).toThrow(/JSON/);
    expect(parseCredits("{}", names)).toEqual({});
  });

  it("puts author {x} in a credited look's entry only, and never a claim in the package", () => {
    const manifest = { ...base.manifest, name: "harbor", author_x: "claimed_one" };
    const pkg = { url: "https://example.com/p.json", sha256: "0", bytes: 1 };
    const credited = catalogEntry(manifest, { harbor: "maker_01" }, [], pkg);
    expect(credited.author).toEqual({ x: "maker_01" });
    expect(credited).not.toHaveProperty("author_x");
    expect(Object.keys(credited).slice(-3)).toEqual(["author", "slots", "package"]);
    const plain = catalogEntry(manifest, {}, [], pkg);
    expect(plain).not.toHaveProperty("author");
    expect(plain).not.toHaveProperty("author_x");
    expect(packageManifest(manifest)).not.toHaveProperty("author_x");
    expect(packageManifest(manifest).name).toBe("harbor");
  });

  it("shows author_x in theme_list's catalog when credited", () => {
    const [a, b, c] = themes.listing([
      { name: "one", slots: { images: [{}, {}] }, package: {}, author: { x: "maker_01" } },
      { name: "two", slots: {}, package: {} },
      { name: "three", package: {}, author: { x: "not a handle" } },
    ]);
    expect(a).toEqual({ name: "one", needs_images: 2, author_x: "maker_01" });
    expect(b).toEqual({ name: "two", needs_images: 0 });
    expect(c).toEqual({ name: "three", needs_images: 0 });
  });

  it("credits the maker in the demo bar, linking to their X profile", () => {
    expect(creditHtml("maker_01")).toBe(' by <a style="color:#9fd8c4" href="https://x.com/maker_01" rel="noopener noreferrer">@maker_01</a>');
    expect(creditHtml(undefined)).toBe("");
    expect(creditHtml('x" onclick="y')).toBe("");
  });
});

describe("credit for a shared look", () => {
  beforeEach(async () => {
    await applyBoardSchema(db);
    await db.prepare("DELETE FROM board_submissions").run();
  });

  async function share(name: string, x?: string, manifestX?: string) {
    const sample = JSON.parse((await import("../../themes/product-page/sample.json?raw")).default);
    await themes.create(db, { manifest: { ...base.manifest, name, ...(manifestX ? { author_x: manifestX } : {}) }, sample, pages: base.pages, partials: base.partials, css: base.static["site.css"] }, "assistant:test", async () => Response.json({ themes: [] }));
    return requests.submit(db, "https://bakery.example", "assistant:test", name, "For tea rooms: a menu-led front page.", toQueue, x);
  }
  const look = async (id: string) => (await (await curator(`/curator/submissions/${id}`)).json()) as Record<string, any>;

  it("answers a claim with a one-time code and the words to post on X", async () => {
    const s = await share("tea-house", "maker_01");
    expect(s.credit.author_x).toBe("maker_01");
    expect(s.credit.claim_code).toMatch(/^[A-Z2-9]{8}$/);
    expect(s.credit.instructions).toBe(
      `To be credited, post this from @maker_01 on X: 'Porchsite look tea-house: ${s.credit.claim_code}'. The curator checks it before the look is published with your name; until then it is published without credit.`,
    );
    expect(creditInstructions("maker_01", "tea-house", s.credit.claim_code)).toBe(s.credit.instructions);
    // The curator sees the claimed handle and code, unchecked; the package itself carries no claim.
    const list = (await (await curator("/curator/submissions")).json()) as { submissions: Record<string, any>[] };
    expect(list.submissions.find((x) => x.id === s.id)).toMatchObject({ author_x: "maker_01", claim_code: s.credit.claim_code, credit_verified: null });
    const one = await look(s.id);
    expect(one).toMatchObject({ author_x: "maker_01", claim_code: s.credit.claim_code, credit_verified: null });
    // No claim, no code.
    const plain = await share("tea-room");
    expect(plain).not.toHaveProperty("credit");
    expect(await look(plain.id)).toMatchObject({ author_x: "", claim_code: "", credit_verified: null });
  });

  it("takes the claim from the manifest too, and keeps it out of the stored package", async () => {
    const s = await share("tea-garden", undefined, "maker_02");
    expect(s.credit.author_x).toBe("maker_02");
    const one = await look(s.id);
    expect(one.author_x).toBe("maker_02");
    expect(one.package.manifest).not.toHaveProperty("author_x");
  });

  it("publishes with credit only once the curator has verified it", async () => {
    const s = await share("tea-house", "maker_01");
    const undecided = await curator(`/curator/submissions/${s.id}`, { action: "publish" });
    expect(undecided.status).toBe(400);
    expect(((await undecided.json()) as { error: string }).error).toBe("credit_undecided");
    expect((await curator(`/curator/submissions/${s.id}`, { action: "publish", credit_verified: "yes" })).status).toBe(400);
    const r = (await (await curator(`/curator/submissions/${s.id}`, { action: "publish", credit_verified: true, note: "Thanks." })).json()) as Record<string, any>;
    expect(r).toMatchObject({ state: "published", credit: { x: "maker_01" } });
    expect(await look(s.id)).toMatchObject({ author_x: "maker_01", credit_verified: true });
    const credits = (await (await curator("/curator/credits")).json()) as { credits: Record<string, any>[] };
    expect(credits.credits).toEqual([expect.objectContaining({ name: "tea-house", x: "maker_01", submission: s.id })]);
  });

  it("drops an unverified handle: the look is published without credit", async () => {
    const s = await share("tea-house", "maker_01");
    const r = (await (await curator(`/curator/submissions/${s.id}`, { action: "publish", credit_verified: false })).json()) as Record<string, any>;
    expect(r).toMatchObject({ state: "published", credit: null });
    expect(await look(s.id)).toMatchObject({ state: "published", author_x: "", claim_code: "", credit_verified: false });
    expect(((await (await curator("/curator/credits")).json()) as { credits: unknown[] }).credits).toEqual([]);
    // A look that claims nothing has nothing to verify.
    const plain = await share("tea-room");
    expect((await curator(`/curator/submissions/${plain.id}`, { action: "publish", credit_verified: true })).status).toBe(400);
    expect((await curator(`/curator/submissions/${plain.id}`, { action: "publish" })).status).toBe(200);
  });

  it("forgets the handle of a rejected look", async () => {
    const s = await share("tea-house", "maker_01");
    await curator(`/curator/submissions/${s.id}`, { action: "reject", note: "Too close to product-page." });
    expect(await look(s.id)).toMatchObject({ author_x: "", claim_code: "", credit_verified: false });
  });

  it("removes a published look's credit on request; the catalog follows on its next build", async () => {
    const s = await share("tea-house", "maker_01");
    await curator(`/curator/submissions/${s.id}`, { action: "publish", credit_verified: true });
    expect((await curator("/curator/credits/tea-house", { action: "keep" })).status).toBe(400);
    const r = (await (await curator("/curator/credits/tea-house", { action: "remove" })).json()) as Record<string, any>;
    expect(r).toMatchObject({ name: "tea-house", removed: true });
    expect(r.next).toContain("themes/credits.json");
    expect(await look(s.id)).toMatchObject({ state: "published", author_x: "", claim_code: "", credit_verified: false });
    expect(((await (await curator("/curator/credits")).json()) as { credits: unknown[] }).credits).toEqual([]);
    expect((await toQueue("https://get.porchsite.dev/curator/credits")).status).toBe(401);
  });

  it("tells the sharing site where its claim stands, never the handle or the code", async () => {
    const credited = await share("tea-house", "maker_01");
    const dropped = await share("tea-garden", "maker_02");
    const plain = await share("tea-room");
    const mine = async () => Object.fromEntries((await requests.mySubmissions(db, toQueue)).map((x) => [x.id, x]));
    let m = await mine();
    expect(m[credited.id]).toMatchObject({ name: "tea-house", status: "new", credit: "waiting" });
    expect(m[dropped.id].credit).toBe("waiting");
    expect(m[plain.id]).not.toHaveProperty("credit");
    const raw = await (await toQueue(`https://get.porchsite.dev/submissions/status?ids=${credited.id},${dropped.id},${plain.id}`)).text();
    for (const secret of [credited.credit.claim_code, dropped.credit.claim_code, "maker_01", "maker_02", "author_x", "claim_code"]) expect(raw).not.toContain(secret);

    await curator(`/curator/submissions/${credited.id}`, { action: "publish", credit_verified: true });
    await curator(`/curator/submissions/${dropped.id}`, { action: "reject", note: "Too close to product-page." });
    // A look that claimed nothing stays without credit, whatever the curator sends.
    await curator(`/curator/submissions/${plain.id}`, { action: "publish", credit_verified: false });
    m = await mine();
    expect(m[credited.id]).toMatchObject({ status: "published", credit: "credited" });
    expect(m[dropped.id]).toMatchObject({ status: "rejected", credit: "not credited" });
    expect(m[plain.id]).toMatchObject({ status: "published" });
    expect(m[plain.id]).not.toHaveProperty("credit");
    expect(await look(plain.id)).toMatchObject({ credit_verified: null });

    await curator("/curator/credits/tea-house", { action: "remove" });
    expect((await mine())[credited.id].credit).toBe("not credited");
  });

  it("passes on only the credit words it knows", async () => {
    const s = await share("tea-house", "maker_01");
    const odd = async (url: string) =>
      url.includes("/submissions/status") ? Response.json({ submissions: [{ id: s.id, status: "new", note: "", credit: "maybe" }] }) : new Response("", { status: 404 });
    expect((await requests.mySubmissions(db, odd)).find((x) => x.id === s.id)).not.toHaveProperty("credit");
  });

  it("refuses a claim that isn't an X handle", async () => {
    const r = await share("tea-house", "@maker").catch((x) => x);
    expect(r.code).toBe("bad_author_x");
  });
});

describe("theme_submit's author_x", () => {
  async function rpc(method: string, params: unknown) {
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    return ((await res.json()) as { result: any }).result;
  }

  it("is optional and must be an X handle", async () => {
    const tools = (await rpc("tools/list", {})).tools as { name: string; inputSchema: any }[];
    const t = tools.find((x) => x.name === "theme_submit")!;
    expect(t.inputSchema.properties.author_x).toMatchObject({ type: "string", pattern: "^[A-Za-z0-9_]{1,15}$" });
    expect(t.inputSchema.required).toEqual(["name", "note"]);
    const bad = await rpc("tools/call", { name: "theme_submit", arguments: { name: "tea-house", note: "For tea rooms: a menu-led front page.", author_x: "@maker" } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("author_x");
  });
});
