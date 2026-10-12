// The site's mark and share picture, as the product-page theme prints them.
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
const at = (path: string) => handle(new Request(`https://site.example${path}`), e);

async function publish(ids: string[]) {
  const req = await approvals.request(db, who, ids, "");
  await approvals.decide(db, req.id, Object.fromEntries(ids.map((id) => [id, { decision: "approve" }])), "");
}

describe("mark and share picture", () => {
  it("shows the mark, uses it as the icon, and shares the share picture", async () => {
    const m = await media.store(db, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "image/jpeg", "test");
    const siteItem = await content.createItem(
      db,
      who,
      "site",
      { title: "Kettle", tagline: "Tea.", theme: "product-page", logo: m, logo_alt: "A kettle", share_image: m, share_image_alt: "A kettle on a stove" },
      undefined,
    );
    await publish([siteItem.id]);
    const home = await (await at("/")).text();
    expect(home).toContain(`<img class="brand-mark press-img" src="${m}" alt="A kettle"`);
    expect(home).toContain(`<link rel="icon" href="${m}">`);
    expect(home).toContain(`<meta name="twitter:image" content="https://site.example${m}">`);
    expect(home).toContain('<meta name="twitter:image:alt" content="A kettle on a stove">');
    expect((await at(m)).status).toBe(200);
  });
});
