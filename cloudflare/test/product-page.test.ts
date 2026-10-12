// The product-page theme: a product page set like a newspaper front.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import { ApiError } from "../src/errors";
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

describe("product-page theme", () => {
  it("prints a product page from content", async () => {
    const siteItem = await content.createItem(
      db,
      who,
      "site",
      {
        title: "Kettle",
        tagline: "Tea, on time.",
        intro: "A timer that knows the leaf.",
        hero_caption: "Vol. I · October 2026 · Free",
        theme: "product-page",
        handle: "kettle_dev",
        footer_line: "Kettle · MIT",
        cta_label: "Get started",
        cta_link: "/pages/start/",
        cta2_label: "How it works",
        cta2_link: "/pages/how/",
        links: [{ label: "How it works", url: "/pages/how/" }],
        streams: [
          { id: "front", title: "Front page", layout: "feature" },
          { id: "pages", title: "More", layout: "list", intro: "Everything else." },
        ],
        sections: ["front", "cards", "pages"],
        cards_title: "Why it's safe",
      },
      undefined,
    );
    const front = await content.createItem(
      db,
      who,
      "entry",
      { stream: "front", title: "Overview", date: "2026-10-10", summary: "The story.", body: "## Seven steeps\n\nTimed to the second.\n\n> Patience is a leaf.", stats: [{ value: "7", label: "steeps" }, { value: "0", label: "burnt cups" }] },
      undefined,
    );
    const how = await content.createItem(db, who, "entry", { stream: "pages", title: "How it works", date: "2026-10-09", summary: "Three steps.", body: "Boil. Steep. Drink." }, undefined);
    const c1 = await content.createItem(db, who, "card", { name: "Nothing burns", description: "It stops itself." }, undefined);
    await publish([siteItem.id, front.id, how.id, c1.id]);

    const home = await (await at("/")).text();
    expect(home).not.toContain("{{");
    for (const part of [
      '<p class="dateline">Vol. I · October 2026 · Free</p>',
      "<h1>Tea, on time.</h1>",
      '<a class="b" href="/pages/start/">Get started</a>',
      '<a class="b b2" href="/pages/how/">How it works</a>',
      '<span class="num">7</span><figcaption>steeps</figcaption>',
      "<h2>Seven steeps</h2>",
      "<blockquote>",
      "<h2>Why it&#39;s safe</h2>",
      "<h3>Nothing burns</h3>",
      `<a href="/pages/${how.slug}/">How it works</a> <span>Three steps.</span>`,
      '<nav>\n<a href="/pages/how/">How it works</a>',
      'href="https://x.com/kettle_dev"',
    ]) {
      expect(home, part).toContain(part);
    }
    // No hero image: the headline runs alone.
    expect(home).toContain('<div class="hero-copy solo">');

    const page = await (await at(`/pages/${how.slug}/`)).text();
    expect(page).toContain("<h1>How it works</h1>");
    expect(page).toContain("<p>Boil. Steep. Drink.</p>");
    expect(await (await at("/pages/")).text()).toContain("Everything else.");
    const missing = await at("/nowhere/");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('class="dateline"');
    expect(await (await at("/static/site.css")).text()).toContain(".numbers-rail");
    // Without a photo, the follow link is words only.
    expect(home).toContain('<a class="follow-author" href="https://x.com/kettle_dev" aria-label="Follow on X"><span>Follow on X</span></a>');
  });

  it("puts the owner's photo in the follow link when the site has one", async () => {
    const jpeg = new Uint8Array(900).fill(5);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    const serving: media.Fetcher = async () => new Response(jpeg, { headers: { "content-type": "image/jpeg", "content-length": "900" } });
    // An image field like the logo: copied in at save, and it needs a description.
    const out = await media.localize(db, "site", { follow_image: "https://example.com/me.jpg", follow_image_alt: "Sam Lee" }, serving);
    expect(String(out.follow_image)).toMatch(media.LOCAL);
    let refused: unknown = null;
    await media.localize(db, "site", { follow_image: "https://example.com/me.jpg" }, serving).catch((x) => (refused = x));
    expect(refused).toBeInstanceOf(ApiError);
    expect(JSON.stringify((refused as ApiError).toJSON())).toContain("follow_image_alt");
    const s = await content.getItem(db, "site");
    const s2 = await content.updateItem(db, who, "site", s.version, { follow_image: out.follow_image, follow_image_alt: "Sam Lee" });
    await publish([s2.id]);
    const home = await (await at("/")).text();
    expect(home).toContain(`<a class="follow-author has-photo" href="https://x.com/kettle_dev" aria-label="Follow on X"><img src="${out.follow_image}" width="48" height="48" alt="Sam Lee"><span>Follow on X</span></a>`);
    expect(await (await at("/static/site.css")).text()).toContain(".follow-author.has-photo span { display: none; }");
  });
});
