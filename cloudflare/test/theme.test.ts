// The personal-homepage theme, rendered by this build from its own content.
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

describe("personal-homepage theme", () => {
  it("renders every page from content, with nothing unapproved", async () => {
    const siteItem = await content.createItem(
      db,
      who,
      "site",
      {
        title: "Sam's site",
        tagline: "I build boats.",
        intro: "Mostly wooden ones.",
        theme: "personal-homepage",
        handle: "sam_builds",
        footer_line: "Open to commissions.",
        contact_line: "DM me on X",
        cta_label: "See the work",
        cta_link: "/writing/",
        cta2_label: "My writing",
        timezone: "America/Chicago",
        cards_aside: "Open source",
        cta2_link: "/#writing",
        streams: [
          { id: "journal", title: "The log", byline: "kept by an assistant", layout: "feature", author: "Helper", intro: "What happened this week.", path: "log", anchor: "hands" },
          { id: "writing", title: "My writing", byline: "Written by me", layout: "list", link_label: "Read on Substack", nav_label: "Writing", description: "Essays by @{handle}.", feed_subtitle: "New essays by @{handle}." },
        ],
        sections: ["journal", "cards", "writing", "about"],
        about: "First paragraph.\n\nSecond paragraph.",
      },
      undefined,
    );
    const j1 = await content.createItem(db, who, "entry", { stream: "journal", title: "Hull done", date: "2026-10-08", summary: "Planked.", body: "All **planked**.", stats: [{ value: "12", label: "planks" }] }, undefined);
    const j2 = await content.createItem(db, who, "entry", { stream: "journal", title: "Keel laid", date: "2026-10-01", summary: "Started." }, undefined);
    const w1 = await content.createItem(db, who, "entry", { stream: "writing", title: "Why wood", date: "2026-10-05", summary: "An essay.", external_url: "https://example.com/why-wood", tags: ["boats"] }, undefined);
    const c1 = await content.createItem(db, who, "card", { name: "Skiff", description: "A small boat.", badge: "Live", badge_tone: "live", group: "Boats" }, undefined);
    const c2 = await content.createItem(db, who, "card", { name: "Plans", description: "Free boat plans.", link: "https://example.org/plans", group: "Open source" }, undefined);
    const n1 = await content.createItem(db, who, "note", { text: "Bought cedar.", date: "2026-10-07" }, undefined);
    const hidden = await content.createItem(db, who, "entry", { stream: "journal", title: "Not approved yet", date: "2026-10-09", summary: "x" }, undefined);
    await publish([siteItem.id, j1.id, j2.id, w1.id, c1.id, c2.id, n1.id]);

    const home = await (await at("/")).text();
    for (const part of ["I build boats.", "The log", "kept by an assistant", "What happened this week.", "Hull done", "planks", "Bought cedar.", "Skiff", "My writing", "Why wood", "Read on Substack", "Second paragraph.", "Open to commissions.", "https://x.com/sam_builds", "See the work", "All of The log", 'href="/log/"']) {
      expect(home, part).toContain(part);
    }
    expect(home).not.toContain("{{");
    expect(home).toContain('href="/#writing">My writing</a>');
    expect(home).toContain("badge-live");
    expect(home).toMatch(/<h3 class="group-label">Open source<\/h3>\s*<div class="cards">\s*<a class="card" data-group="open-source" href="https:\/\/example.org\/plans">/);
    expect(home).toMatch(/Last update [A-Z][a-z]{2} \d+, \d+:\d\d [AP]M CT/);
    expect(home).not.toContain("Not approved yet");
    expect(hidden.id).toBeTruthy();

    const moved = await at(`/e/${j1.slug}/`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(`/log/${j1.slug}/`);
    expect(home).toContain('<section id="hands">');
    const page = await (await at(`/log/${j1.slug}/`)).text();
    expect(page).toContain("<strong>planked</strong>");
    expect(page).toContain("kept by an assistant");
    expect((await at(`/e/${w1.slug}/`)).headers.get("location")).toBe("https://example.com/why-wood");

    const archive = await (await at("/log/")).text();
    expect(archive).toContain("Keel laid");
    expect(archive).toContain("What happened this week.");
    expect(await (await at("/writing/tags/boats/")).text()).toContain("Why wood");
    expect(await (await at("/writing/")).text()).toContain('content="Essays by @sam_builds."');
    const wfeed = await (await at("/writing/feed.xml")).text();
    expect(wfeed).toContain("<subtitle>New essays by @sam_builds.</subtitle>");
    expect(wfeed).toContain("<title>Writing · Sam&#39;s site</title>");
    expect(wfeed).toContain("<author><name>@sam_builds</name></author>");
    expect(wfeed).toContain('<link href="https://site.example/writing/"/>');

    const index = (await (await at("/writing/search.json")).json()) as { t: string; x: boolean }[];
    expect(index).toEqual([expect.objectContaining({ t: "Why wood", x: true })]);

    const atom = await at("/log/feed.xml");
    expect(atom.headers.get("content-type")).toContain("atom");
    const atomText = await atom.text();
    expect(atomText).toContain("<title>Hull done</title>");
    expect(atomText).toContain("<author><name>Helper for @sam_builds</name></author>");
    expect(atomText).not.toContain("Not approved yet");
    expect(home).toContain('href="/log/feed.xml"');

    const css = await at("/static/site.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    const missing = await at("/nowhere/");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Nothing here.");
    // The owner's pages are untouched by the theme.
    expect((await at("/review")).status).toBe(303);
  });
});

describe("image size", () => {
  it("measures an image stored before sizes were kept", async () => {
    const png = new Uint8Array(40);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x02, 0x00, 0, 0, 0x01, 0x00]);
    const path = await media.store(db, png, "image/png", "test");
    const name = path.slice("/media/".length);
    await db.prepare("UPDATE media SET width = 0, height = 0 WHERE name = ?").bind(name).run();
    expect(await media.sizeOf(db, name)).toEqual([512, 256]);
    expect(await db.prepare("SELECT width FROM media WHERE name = ?").bind(name).first("width")).toBe(512);
  });

  it("reads width and height from PNG and JPEG headers", () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x04, 0x00, 0, 0, 0x03, 0x00]);
    expect(media.size(png)).toEqual([1024, 768]);
    // SOI, an APP0 segment to skip, then SOF0 with height 580, width 1040.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x44, 0x04, 0x10, 3, 0, 0, 0, 0]);
    expect(media.size(jpeg)).toEqual([1040, 580]);
    expect(media.size(new Uint8Array([1, 2, 3]))).toEqual([0, 0]);
  });
});
