// Batch image_add acceptance: port-matched with test_stage_two_images.py.
import { env } from "cloudflare:workers";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createServer } from "../src/mcp";
import worker from "../src/index";
import * as uploads from "../src/uploads";

const db = (env as unknown as Env).DB;
const png = (n: number, bytes = 24) => btoa(String.fromCharCode(...[137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,n,0,0,0,1]) + "\0".repeat(bytes - 24));
async function callImage(args: Record<string, unknown>) {
  // In-memory MCP keeps boundary tests from allocating an extra 44 MB HTTP
  // JSON string; the real tool's schema and handler still process the data.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "image_add", arguments: args });
    const block = (result.content as { type: string; text: string }[])[0];
    let value: any;
    try { value = JSON.parse(block.text); } catch { value = block.text; }
    return { error: !!result.isError, value };
  } finally {
    await client.close();
    await server.close();
  }
}
const imageAdd = (images: string[]) => callImage({ images });
async function stored() {
  return {
    media: (await db.prepare("SELECT name, size FROM media ORDER BY name").all()).results,
    chunks: (await db.prepare("SELECT name, n, length(data) AS bytes FROM media_chunks ORDER BY name, n").all()).results,
  };
}

it("accepts eight pictures in input order", async () => {
  const result = await imageAdd(Array.from({ length: 8 }, (_, n) => png(n + 1)));
  expect(result.error).toBe(false);
  expect(result.value.images).toHaveLength(8);
  expect(result.value.images.map((x: any) => [x.width, x.height])).toEqual(Array.from({ length: 8 }, (_, n) => [n + 1, 1]));
  expect(new Set(result.value.images.map((x: any) => x.image)).size).toBe(8);
});

it("refuses nine pictures without storing anything", async () => {
  const before = await stored();
  const result = await imageAdd(Array.from({ length: 9 }, (_, n) => png(n + 20)));
  expect(result.error).toBe(true);
  expect(JSON.stringify(result.value)).toMatch(/8|eight/i);
  expect(await stored()).toEqual(before);
});

it("accepts exactly 8 MiB decoded spread over eight files", async () => {
  const result = await imageAdd(Array.from({ length: 8 }, (_, n) => png(150 + n, 1024 * 1024)));
  expect(result.error).toBe(false);
  expect(result.value.images).toHaveLength(8);
  expect(result.value.images.map((x: any) => [x.width, x.height])).toEqual(Array.from({ length: 8 }, (_, n) => [150 + n, 1]));
});

it("refuses 8 MiB plus one byte decoded before decoding any file", async () => {
  const before = await stored();
  const first = png(60, 4 * 1024 * 1024);
  const second = png(61, 4 * 1024 * 1024 + 1);
  const decode = vi.spyOn(globalThis, "atob");
  let result;
  try {
    result = await imageAdd([first, second]);
    expect(decode).not.toHaveBeenCalled();
  } finally { decode.mockRestore(); }
  expect(result.error).toBe(true);
  expect(JSON.stringify(result.value)).toMatch(/8/);
  expect(await stored()).toEqual(before);
});

it("stores none when one bad picture follows valid pictures", async () => {
  const before = await stored();
  const result = await imageAdd([...Array.from({ length: 7 }, (_, n) => png(80 + n)), btoa("this is not an image")]);
  expect(result.error).toBe(true);
  expect(result.value.error).toBe("not_an_image");
  expect(await stored()).toEqual(before);
});

it.each(["<svg></svg>", "<html>not a picture</html>", "GIF89a", "%PDF-1.7", "\xff\xd8"])("sniffs every batch file rather than trusting declared type: %s", async raw => {
  const before = await stored();
  const result = await imageAdd([png(120), `data:image/png;base64,${btoa(raw)}`]);
  expect(result.error).toBe(true);
  expect(result.value.error).toBe("not_an_image");
  expect(await stored()).toEqual(before);
});

it("uses sniffed type and byte hash, ignoring a supplied filename", async () => {
  const encoded = png(121);
  const result = await callImage({ images: [`data:image/gif;base64,${encoded}`], name: "../../etc/passwd", filename: "wrong.jpg" });
  expect(result.error).toBe(false);
  const raw = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const hash = [...digest.slice(0, 16)].map(x => x.toString(16).padStart(2, "0")).join("");
  expect(result.value.images[0]).toEqual({ image: `/media/${hash}.png`, width: 121, height: 1 });
});

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const go = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://site.example${path}`, init), env as unknown as Env, ctx);

it("requires auth for both inputs and exposes no public batch endpoint", async () => {
  const before = await stored();
  for (const args of [{ data: png(122) }, { images: [png(123)] }]) {
    const result = await go("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "image_add", arguments: args } }) });
    expect(result.status).toBe(401);
  }
  for (const path of ["/image_add", "/images", "/api/images"]) {
    const result = await go(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ images: [png(124)] }) });
    expect(result.status).toBeGreaterThanOrEqual(300);
  }
  expect(await stored()).toEqual(before);
});

it("keeps batch output private and the one-shot photo link single-file", async () => {
  const result = await imageAdd([png(125)]);
  expect(result.error).toBe(false);
  expect((await go(result.value.images[0].image)).status).toBe(404);
  const before = await stored();
  const link = await uploads.create(db, "assistant:test", "");
  const form = new FormData();
  for (const n of [126, 127]) form.append("photo", new File([Uint8Array.from(atob(png(n)), c => c.charCodeAt(0))], `${n}.png`, { type: "image/png" }));
  form.set("alt", "Test pictures");
  const response = await go(link.path, { method: "POST", body: form, headers: { Accept: "application/json" } });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await stored()).toEqual(before);
  expect((await uploads.get(db, link.id)).status).toBe("waiting");
});

it("keeps legacy data and one-element batch response shapes distinct", async () => {
  const legacy = await callImage({ data: png(90) });
  expect(legacy.error).toBe(false);
  expect(legacy.value.image).toMatch(/^\/media\/[a-f0-9]{32}\.png$/);
  expect(legacy.value.images).toBeUndefined();
  const batch = await imageAdd([png(90)]);
  expect(batch.error).toBe(false);
  expect(batch.value.images).toEqual([{ image: legacy.value.image, width: 90, height: 1 }]);
  expect(batch.value.image).toBeUndefined();
});

it.each([{}, { data: png(91), images: [png(92)] }, { images: [] }, { images: null }, { images: [null] }, { images: [[png(93)]] }, { images: {} }, { data: png(94), images: null }, { data: null, images: [png(95)] }])("refuses invalid argument shapes without writes: %j", async args => {
  const before = await stored();
  expect((await callImage(args)).error).toBe(true);
  expect(await stored()).toEqual(before);
});

it("rejects bad base64 and an oversized individual file before writes", async () => {
  const before = await stored();
  const malformed = await imageAdd([png(94), "not base64!!"]);
  expect(malformed.error).toBe(true);
  expect(malformed.value.error).toBe("invalid");
  const oversized = await imageAdd([png(95), png(96, 8 * 1024 * 1024 + 1)]);
  expect(oversized.error).toBe(true);
  expect(JSON.stringify(oversized.value)).toMatch(/8/);
  expect(await stored()).toEqual(before);
});

it("returns duplicate positions while storing the hash once", async () => {
  const before = await stored();
  const result = await imageAdd([png(97), png(97)]);
  expect(result.error).toBe(false);
  expect(result.value.images).toHaveLength(2);
  expect(result.value.images[0]).toEqual(result.value.images[1]);
  expect((await stored()).media.length).toBe(before.media.length + 1);
});

it("keeps existing hashes and rolls back a failing D1 batch", async () => {
  expect((await callImage({ data: png(98) })).error).toBe(false);
  const before = await stored();
  const original = db.batch.bind(db);
  const spy = vi.spyOn(db, "batch").mockImplementation(async stmts => original([...stmts, db.prepare("INSERT INTO media (name) VALUES (NULL)")]));
  try {
    const result = await imageAdd([png(98), png(99), png(100)]);
    expect(result.error).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
  expect(await stored()).toEqual(before);
});

it("an overlapping failed call leaves only the successful batch's images", async () => {
  const before = await stored();
  const [success, failure] = await Promise.all([
    imageAdd([png(130), png(131)]),
    imageAdd([png(130), png(132), btoa("not an image")]),
  ]);
  expect(success.error).toBe(false);
  expect(failure.error).toBe(true);
  const after = await stored();
  const known = new Set(before.media.map(row => row.name));
  expect(after.media.filter(row => !known.has(row.name)).map(row => `/media/${row.name}`).sort()).toEqual(success.value.images.map((x: any) => x.image).sort());
});
