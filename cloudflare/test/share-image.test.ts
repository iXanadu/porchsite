// An archive or tag page's share picture is the cover of its newest entry
// that has one (TEMPLATES §3 meta). Port-matched: server/tests/spec/test_share_image.py.
import { describe, expect, it } from "vitest";
import { validate } from "../src/content";
import * as site from "../src/site";
import * as theme from "../src/theme";

const s = validate("site", { title: "Kettle", share_image: "/media/0123456789abcdef0123456789abcdef.jpg", share_image_alt: "A kettle" });
const entry = (id: string, date: string, data: Record<string, unknown>) => ({
  id,
  kind: "entry",
  slug: id,
  data: validate("entry", { title: id, date, tags: ["tea"], ...data }),
});

describe("share image", () => {
  it("uses the newest cover on archive and tag pages, else the site's", () => {
    const cover = "/media/fedcba9876543210fedcba9876543210.jpg";
    const v = site.view(s, [
      entry("old", "2026-10-01", { cover: "/media/00000000000000000000000000000000.jpg", cover_alt: "Old" }),
      entry("mid", "2026-10-02", { cover, cover_alt: "Mid" }),
      entry("new", "2026-10-03", { tags: ["coffee"] }),
    ]);
    const arch = theme.archiveView(v, "journal", "1", "https://site.example")!;
    expect((arch.meta as { image: string }).image).toBe(`https://site.example${cover}`);
    const tag = theme.archiveView(v, "journal", "1", "https://site.example", "coffee")!;
    expect((tag.meta as { image: string }).image).toBe("https://site.example/media/0123456789abcdef0123456789abcdef.jpg");
  });
});
