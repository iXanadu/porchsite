// HEAD is GET without the body, on every address (SPEC §6): pages, feeds,
// static files, media and the 404 page, in the built-in look and a theme.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import * as media from "../src/media";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;
const who = "assistant:test";
const at = (path: string, method = "GET") => handle(new Request(`https://site.example${path}`, { method }), e);

async function publish(ids: string[]) {
  const req = await approvals.request(db, who, ids, "");
  await approvals.decide(db, req.id, Object.fromEntries(ids.map((id) => [id, { decision: "approve" }])), "");
}

/** GET and HEAD agree on status and type; HEAD has no body. */
async function same(path: string, status: number) {
  const get = await at(path);
  const head = await at(path, "HEAD");
  expect([path, get.status]).toEqual([path, status]);
  expect([path, head.status]).toEqual([path, status]);
  expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
  expect(head.headers.get("cache-control")).toBe(get.headers.get("cache-control"));
  expect((await get.arrayBuffer()).byteLength).toBeGreaterThan(0);
  expect(head.body).toBeNull();
  expect(await head.text()).toBe("");
}

describe("HEAD", () => {
  let entry = "";
  let image = "";

  it("answers like GET in the built-in look", async () => {
    image = await media.store(db, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]), "image/png", "test");
    const s = await content.createItem(
      db,
      who,
      "site",
      { title: "Boats", tagline: "Built by hand.", streams: [{ id: "journal", title: "Log" }], logo: image, logo_alt: "A boat" },
      undefined,
    );
    const en = await content.createItem(db, who, "entry", { stream: "journal", title: "Hull", date: "2026-10-08", body: "Done." }, undefined);
    await publish([s.id, en.id]);
    entry = `/journal/${en.slug}/`;
    await same("/", 200);
    await same(entry, 200);
    await same("/journal/feed.xml", 200);
    await same(image, 200);
    await same("/robots.txt", 200);
    await same("/static/a.js", 200);
    await same("/journal/nothing/", 404);
    await same("/nowhere", 404);
  });

  it("answers like GET in a theme", async () => {
    const s = await content.getItem(db, "site");
    await content.updateItem(db, who, "site", s.version, { ...s.data, theme: "personal-homepage" });
    await publish(["site"]);
    expect(await (await at("/")).text()).toContain("/static/site.css");
    await same("/", 200);
    await same(entry, 200);
    await same("/journal/", 200);
    await same("/journal/feed.xml", 200);
    await same("/static/site.css", 200);
    await same(image, 200);
    await same("/journal/nothing/", 404);
    await same("/nowhere", 404);
  });
});
