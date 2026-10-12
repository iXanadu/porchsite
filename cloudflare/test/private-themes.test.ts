// A look the assistant makes for one site: the same gates as a reviewed
// theme, no scripts, and only that site has it.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import { ApiError } from "../src/errors";
import { handle } from "../src/routes";
import { THEMES } from "../src/themes.gen";
import * as themes from "../src/themes";
import sampleText from "../../themes/product-page/sample.json?raw";

const e = env as unknown as Env;
const db = e.DB;
const who = "assistant:test";
const noCatalog = async () => Response.json({ themes: [{ name: "taken-in-catalog", package: { url: "", sha256: "" } }] });
const base = THEMES["product-page"];
const made = (name: string, over: Partial<themes.Made> = {}): themes.Made => ({
  manifest: { ...base.manifest, name, title: "Tea house" },
  sample: JSON.parse(sampleText),
  pages: { ...base.pages, home: base.pages.home.replace("<h1>", '<h1 class="tea">') },
  partials: base.partials,
  css: `${base.static["site.css"]}\n.tea{letter-spacing:.02em}`,
  ...over,
});
const refused = (p: Promise<unknown>) => p.then(() => null, (x) => x as ApiError);

describe("private looks", () => {
  it("stores a sound look for this site, which renders once approved", async () => {
    expect(await themes.create(db, made("tea-house"), who, noCatalog)).toEqual({ name: "tea-house", version: base.manifest.version });
    expect((await themes.installed(db)).find((t) => t.name === "tea-house")?.source).toBe("private");
    const s = await content.createItem(db, who, "site", { title: "Tea", tagline: "Steeped.", theme: "tea-house" }, undefined);
    const r = await approvals.request(db, who, [s.id], "");
    await approvals.decide(db, r.id, { [s.id]: { decision: "approve" } }, "");
    expect(await (await handle(new Request("https://site.example/"), e)).text()).toContain('<h1 class="tea">Steeped.</h1>');
  });

  it("refuses scripts, fixed words, outside addresses and taken names", async () => {
    const withScript = await refused(themes.create(db, made("a-look", { pages: { ...base.pages, home: `${base.pages.home}<script src="/static/x.js"></script>` } }), who, noCatalog));
    expect(withScript?.code).toBe("theme_problems");
    expect(withScript?.message).toMatch(/scripts only from the site's kit/);
    const words = await refused(themes.create(db, made("b-look", { pages: { ...base.pages, not_found: "<p>Oops, gone</p>" } }), who, noCatalog));
    expect(words?.message).toMatch(/fixed words \(Oops, gone\)/);
    const outside = await refused(themes.create(db, made("c-look", { css: "body{background:url(https://tracker.example/p.gif)}" }), who, noCatalog));
    expect(outside?.message).toMatch(/outside address/);
    expect((await refused(themes.create(db, made("product-page"), who, noCatalog)))?.code).toBe("name_taken");
    expect((await refused(themes.create(db, made("classic"), who, noCatalog)))?.code).toBe("name_taken");
    expect((await refused(themes.create(db, made("taken-in-catalog"), who, noCatalog)))?.code).toBe("name_taken");
  });
});
