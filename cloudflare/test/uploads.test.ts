// A photo from the person's phone, through a one-time link.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import * as media from "../src/media";
import { handle } from "../src/routes";
import * as uploads from "../src/uploads";

const e = env as unknown as Env;
const db = e.DB;
const site = "https://site.example";

const jpeg = (size: number, fill: number) => {
  const b = new Uint8Array(size).fill(fill);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};

function post(path: string, photo: Uint8Array | null, alt: string, headers: HeadersInit = {}): Request {
  const form = new FormData();
  if (photo) form.set("photo", new File([photo], "p.jpg", { type: "image/jpeg" }));
  form.set("alt", alt);
  return new Request(`${site}${path}`, { method: "POST", body: form, headers });
}

describe("photo upload links", () => {
  it("takes one photo, once, and hands it to the assistant", async () => {
    const link = await uploads.create(db, "assistant:test", "cover for the trip post");
    expect(link.status).toBe("waiting");
    const page = await handle(new Request(`${site}${link.path}`), e);
    expect(await page.text()).toContain("cover for the trip post");

    const sent = await handle(post(link.path, jpeg(3000, 21), "The boat at the dock"), e);
    expect(await sent.text()).toContain("Got it");
    const done = await uploads.get(db, link.id);
    expect(done.status).toBe("done");
    expect(done.image).toMatch(media.LOCAL);
    expect(done.alt).toBe("The boat at the dock");

    // Not public yet: no published item uses it.
    expect(await media.published(db, String(done.image).slice("/media/".length))).toBe(false);

    const again = await handle(post(link.path, jpeg(3000, 22), "Another"), e);
    expect(again.status).toBe(410);
    expect((await uploads.get(db, link.id)).image).toBe(done.image);
  });

  it("asks again for a missing description or a file that isn't a photo, keeping the link open", async () => {
    const link = await uploads.create(db, "assistant:test", "");
    expect(await (await handle(post(link.path, jpeg(500, 3), " "), e)).text()).toContain("describe the photo");
    const notPhoto = await handle(post(link.path, new TextEncoder().encode("hello"), "x"), e);
    expect(await notPhoto.text()).toContain("JPEG, PNG or WebP photo");
    expect((await uploads.get(db, link.id)).status).toBe("waiting");
  });

  it("an assistant sending the file itself gets the result in the answer", async () => {
    const link = await uploads.create(db, "assistant:test", "");
    const res = await handle(post(link.path, jpeg(800, 41), "A sunset", { accept: "application/json" }), e);
    const body = (await res.json()) as uploads.Upload;
    expect(body.status).toBe("done");
    expect(body.image).toMatch(media.LOCAL);
    const twice = await handle(post(link.path, jpeg(800, 42), "x", { accept: "application/json" }), e);
    expect(twice.status).toBe(410);
    expect(((await twice.json()) as { error: string }).error).toBe("link_used");
  });

  it("an expired or unknown link is closed", async () => {
    const link = await uploads.create(db, "assistant:test", "");
    await db.prepare("UPDATE uploads SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(link.id).run();
    expect((await uploads.get(db, link.id)).status).toBe("expired");
    expect((await handle(new Request(`${site}${link.path}`), e)).status).toBe(410);
    expect((await handle(new Request(`${site}/upload/${"A".repeat(32)}`), e)).status).toBe(410);
  });
});

describe("robots.txt", () => {
  it("lets every crawler and agent in", async () => {
    const r = await handle(new Request(`${site}/robots.txt`), e);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("User-agent: *\nAllow: /\n");
  });
});
