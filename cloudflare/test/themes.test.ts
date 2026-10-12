// Themes from the catalog: installed only from it, checked against it, and
// what a theme needs from the site.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import { ApiError } from "../src/errors";
import * as media from "../src/media";
import { handle } from "../src/routes";
import { THEMES } from "../src/themes.gen";
import * as themes from "../src/themes";

const e = env as unknown as Env;
const db = e.DB;
const who = "assistant:test";

async function sha(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A catalog with one theme, "harbor": product-page under another name, saying so in its home page. */
async function catalog(tamper = false) {
  const b = THEMES["product-page"];
  const pkg = JSON.stringify({ ...b, manifest: { ...b.manifest, name: "harbor", version: "2.0.0" }, pages: { ...b.pages, home: "HARBOR {{site.tagline}}" } });
  const sum = await sha(pkg);
  const fetcher = async (url: string) => {
    if (url === themes.CATALOG_URL) return Response.json({ themes: [{ name: "harbor", type: "product", package: { url: "https://cat.example/harbor.json", sha256: sum } }] });
    if (url === "https://cat.example/harbor.json") return new Response(tamper ? pkg.replace("HARBOR", "EVIL") : pkg);
    return new Response("", { status: 404 });
  };
  return fetcher;
}

describe("themes", () => {
  it("installs a catalog theme, and the site renders with it once approved", async () => {
    expect(await themes.install(db, "harbor", who, await catalog())).toEqual({ name: "harbor", version: "2.0.0" });
    expect((await themes.installed(db)).find((t) => t.name === "harbor")).toEqual({ name: "harbor", version: "2.0.0", source: "installed" });
    const s = await content.createItem(db, who, "site", { title: "Boats", tagline: "Built by hand.", theme: "harbor" }, undefined);
    const req = await approvals.request(db, who, [s.id], "");
    await approvals.decide(db, req.id, { [s.id]: { decision: "approve" } }, "");
    expect(await (await handle(new Request("https://site.example/"), e)).text()).toBe("HARBOR Built by hand.");
  });

  it("keeps the old names working", async () => {
    expect((await themes.load(db, "classic"))?.manifest.name).toBe("personal-homepage");
    expect((await themes.load(db, "broadsheet"))?.manifest.name).toBe("product-page");
  });

  it("refuses a download that doesn't match the catalog, and themes not in it", async () => {
    const bad = await themes.install(db, "harbor", who, await catalog(true)).catch((x) => x);
    expect((bad as ApiError).code).toBe("bad_download");
    const none = await themes.install(db, "nope", who, await catalog()).catch((x) => x);
    expect((none as ApiError).code).toBe("no_such_theme");
  });

  it("refuses a package that isn't a whole theme", () => {
    const b = THEMES["product-page"];
    const whole = { ...b, manifest: { ...b.manifest, name: "x" } };
    expect(() => themes.check("x", whole, 10)).not.toThrow();
    expect(() => themes.check("y", whole, 10)).toThrow(/says it's x/);
    expect(() => themes.check("x", { ...whole, pages: { home: "" } }, 10)).toThrow(/no entry page/);
    expect(() => themes.check("x", { ...whole, static: { "site.css": "", "../evil": "" } }, 10)).toThrow(/named/);
    expect(() => themes.check("x", whole, 2_000_000)).toThrow(/1 MB/);
  });

  it("says what a theme needs, and what's the wrong shape", async () => {
    // A 2x1 PNG as the mark: product-page wants a square.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0, 8, 2, 0, 0, 0]);
    const m = await media.store(db, png, "image/png", "test");
    const site = await content.getItem(db, "site");
    await content.updateItem(db, who, "site", site.version, { title: "Kettle", tagline: "Tea.", theme: "product-page", logo: m, logo_alt: "A kettle" });
    const n = await themes.needs(db, THEMES["product-page"]);
    const slot = (f: string) => n.images.find((x: { field: string }) => x.field === f);
    expect(slot("site.hero").status).toBe("missing");
    expect(slot("site.logo").status).toBe("wrong shape: it's 512x256 (wide), needs 512x512");
    expect(slot("body").status).toBe("per item: check each one");
    expect(n.content.find((x: { field: string }) => x.field === "site.tagline").status).toBe("filled");
    expect(n.content.find((x: { field: string }) => x.field === "site.hero_caption").status).toBe("missing");
    expect(n.type).toBe("product");
    expect(n.art.steps.length).toBeGreaterThan(3);
    expect(slot("site.logo").prompt).toContain("{subject}");
  });
});
