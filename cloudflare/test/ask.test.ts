// The public request form at /ask: a person asks, spam is turned away
// without third parties, and the curator reads and marks each one.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { askToken, handleBoard } from "../downloads/board/index";
import type { Env } from "../src/env";
import { applyBoardSchema } from "./board-schema";

const db = (env as unknown as Env).DB;
const KEY = "a".repeat(40);
const board = { DB: db, CURATOR_KEY: KEY, ASSETS: {} as Fetcher };

let ip = 0;
const call = async (url: string, init?: RequestInit) => (await handleBoard(new Request(url, init), board)) ?? new Response("", { status: 404 });
const curator = (path: string, body?: unknown, key = KEY) =>
  call(`https://get.porchsite.dev${path}`, body ? { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) } : { headers: { Authorization: `Bearer ${key}` } });

/** A form post from one visitor (by address), rendered 10 seconds ago unless told otherwise. */
async function send(fields: Record<string, string>, opts: { from?: string; age?: number; token?: string } = {}) {
  const form = new URLSearchParams({ kind: "feature", title: "Opening hours block", text: "A block for opening hours, so a shop can show them.", t: opts.token ?? (await askToken(KEY, Date.now() - (opts.age ?? 10_000))), ...fields });
  return call("https://porchsite.dev/ask", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": opts.from ?? `192.0.2.${++ip}` },
    body: form.toString(),
  });
}
const rows = async () => (await db.prepare("SELECT * FROM board_asks ORDER BY created_at").all<Record<string, any>>()).results;

describe("the /ask form", () => {
  beforeEach(async () => {
    await applyBoardSchema(db);
    await db.prepare("DELETE FROM board_asks").run();
  });

  it("renders a plain form on both hosts, with a signed render time and no scripts", async () => {
    for (const host of ["https://porchsite.dev", "https://get.porchsite.dev"]) {
      const r = await call(`${host}/ask`);
      expect(r.status).toBe(200);
      expect(r.headers.get("Content-Type")).toContain("text/html");
      expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
      const html = await r.text();
      expect(html).toContain('<form method="post" action="/ask">');
      for (const name of ["kind", "title", "text", "link", "x", "website", "t"]) expect(html).toContain(`name="${name}"`);
      expect(html).toContain("Your words are read by Porchsite's curator; nothing here is published.");
      expect(html).toMatch(/name="t" value="\d+\.[a-f0-9]{64}"/);
      expect(html).not.toContain("<script");
      expect(html).not.toContain('type="email"');
    }
  });

  it("stores a good one and thanks the person with a reference", async () => {
    const r = await send({ kind: "look", title: "A look  for a choir", text: "Concert dates up top.\r\nThen the members.", link: "https://example.com/choir", x: "@choir_fan" });
    expect(r.status).toBe(200);
    const html = await r.text();
    const id = /ask_[a-f0-9]{12}/.exec(html)?.[0];
    expect(id).toBeTruthy();
    expect(html).toContain("@choir_fan");
    const [row] = await rows();
    expect(row).toMatchObject({ id, kind: "look", title: "A look for a choir", text: "Concert dates up top.\nThen the members.", link: "https://example.com/choir", x: "choir_fan", state: "new", note: "" });
    // Never the address itself.
    expect(row.visitor).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain("192.0.2.");
  });

  it("hands the form back, filled in, when something's wrong", async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ kind: "wish" }, /Choose what it is/],
      [{ title: "" }, /short title/],
      [{ title: "t".repeat(101) }, /100 characters/],
      [{ text: "x".repeat(2001) }, /2,000 characters/],
      [{ link: "http://example.com/" }, /https/],
      [{ link: "https://example.com/a https://example.com/b" }, /https/],
      [{ x: "has space" }, /X handle/],
      [{ x: "a".repeat(16) }, /X handle/],
    ];
    for (const [fields, why] of cases) {
      const r = await send({ title: "Keep me <b>", ...fields });
      expect(r.status, JSON.stringify(fields)).toBe(400);
      const html = await r.text();
      expect(html, JSON.stringify(fields)).toMatch(why);
      if (!("title" in fields)) expect(html).toContain('value="Keep me &lt;b&gt;"');
    }
    expect(await rows()).toEqual([]);
  });

  it("turns away a filled honeypot, a too-quick or forged submit, and too many links", async () => {
    expect((await send({ website: "https://spam.example" })).status).toBe(400);
    const quick = await send({}, { age: 1000 });
    expect(quick.status).toBe(400);
    expect(await quick.text()).toMatch(/wait a few seconds/);
    expect((await send({}, { token: `${Date.now() - 10_000}.${"0".repeat(64)}` })).status).toBe(400);
    expect((await send({}, { token: await askToken("b".repeat(40), Date.now() - 10_000) })).status).toBe(400);
    expect((await send({}, { age: 2 * 86400_000 })).status).toBe(400);
    const links = await send({ text: "See https://a.example and http://b.example and www.c.example" });
    expect(links.status).toBe(400);
    expect(await links.text()).toMatch(/2 links/);
    // Two links (and one in the example field) are fine.
    expect((await send({ text: "See https://a.example and https://b.example", link: "https://c.example/" })).status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("takes 3 a day from one visitor", async () => {
    for (let i = 0; i < 3; i++) expect((await send({ title: `Ask ${i}` }, { from: "198.51.100.7" })).status).toBe(200);
    const fourth = await send({ title: "Ask 3" }, { from: "198.51.100.7" });
    expect(fourth.status).toBe(429);
    expect(await fourth.text()).toContain('value="Ask 3"');
    expect((await send({ title: "Someone else" }, { from: "198.51.100.8" })).status).toBe(200);
    expect(await rows()).toHaveLength(4);
  });

  it("is closed without a curator key", async () => {
    const closed = { DB: db, ASSETS: {} as Fetcher };
    expect((await handleBoard(new Request("https://porchsite.dev/ask"), closed))?.status).toBe(503);
  });
});

describe("the curator's asks", () => {
  beforeEach(async () => {
    await applyBoardSchema(db);
    await db.prepare("DELETE FROM board_asks").run();
  });

  it("needs the curator key", async () => {
    expect((await call("https://get.porchsite.dev/curator/asks")).status).toBe(401);
    expect((await curator("/curator/asks", undefined, "z".repeat(40))).status).toBe(401);
    expect((await call("https://get.porchsite.dev/curator/asks/ask_000000000000", { method: "POST", body: JSON.stringify({ state: "seen" }) })).status).toBe(401);
  });

  it("lists new ones newest first, then marks them", async () => {
    await send({ title: "First" });
    await new Promise((r) => setTimeout(r, 5));
    await send({ title: "Second", kind: "broken", x: "reporter", link: "https://example.com/page" });
    const list = (await (await curator("/curator/asks?state=new")).json()) as { asks: Record<string, any>[] };
    expect(list.asks.map((a) => a.title)).toEqual(["Second", "First"]);
    expect(Object.keys(list.asks[0]).sort()).toEqual(["created_at", "id", "kind", "link", "note", "state", "text", "title", "updated_at", "x"]);
    expect(list.asks[0]).toMatchObject({ kind: "broken", x: "reporter", link: "https://example.com/page", state: "new", note: "" });

    const [second, first] = list.asks;
    const marked = await curator(`/curator/asks/${second.id}`, { state: "planned", note: "Next release." });
    expect(await marked.json()).toEqual({ id: second.id, state: "planned", note: "Next release." });
    // Without a note, the note stays.
    expect(await (await curator(`/curator/asks/${second.id}`, { state: "done" })).json()).toEqual({ id: second.id, state: "done", note: "Next release." });
    await curator(`/curator/asks/${first.id}`, { state: "seen" });

    expect(((await (await curator("/curator/asks")).json()) as { asks: unknown[] }).asks).toEqual([]);
    const seen = (await (await curator("/curator/asks?state=seen")).json()) as { asks: { id: string }[] };
    expect(seen.asks.map((a) => a.id)).toEqual([first.id]);
    expect(((await (await curator("/curator/asks?state=all")).json()) as { asks: unknown[] }).asks).toHaveLength(2);

    expect((await curator(`/curator/asks/${first.id}`, { state: "archived" })).status).toBe(400);
    expect((await curator(`/curator/asks/${first.id}`, { state: "seen", note: 5 })).status).toBe(400);
    expect((await curator("/curator/asks?state=archived")).status).toBe(400);
    expect((await curator("/curator/asks/ask_000000000000", { state: "spam" })).status).toBe(404);
  });
});
