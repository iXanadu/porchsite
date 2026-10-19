// The Grok Bot template's skills at porchsite.dev/skills/: the manifest and
// each SKILL.md from the release's files, read-only, with the headers the
// template's updater relies on.
import { describe, expect, it } from "vitest";
import { skills } from "../downloads/board/index";
type Env = Parameters<typeof skills>[1];

const FILES: Record<string, string> = {
  "/skills/manifest.json": '{"version":"2026.01.01-abc1234","skills":[]}\n',
  "/skills/porchsite-website-helper/SKILL.md": "---\nname: porchsite-website-helper\n---\n",
};
const env = {
  ASSETS: { fetch: async (r: Request) => (FILES[new URL(r.url).pathname] ? new Response(FILES[new URL(r.url).pathname]) : new Response("", { status: 404 })) },
} as unknown as Env;
const get = async (path: string, method = "GET") => (await skills(new Request(`https://porchsite.dev${path}`, { method }), env))!;

describe("the skills at /skills/", () => {
  it("answers the manifest at /skills, /skills/ and /skills/manifest.json", async () => {
    for (const p of ["/skills", "/skills/", "/skills/manifest.json"]) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(r.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(await r.text()).toBe(FILES["/skills/manifest.json"]);
    }
  });

  it("answers a skill as Markdown, and HEAD without a body", async () => {
    const r = await get("/skills/porchsite-website-helper/SKILL.md");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await r.text()).toBe(FILES["/skills/porchsite-website-helper/SKILL.md"]);
    const h = await get("/skills/porchsite-website-helper/SKILL.md", "HEAD");
    expect(h.status).toBe(200);
    expect(await h.text()).toBe("");
  });

  it("refuses anything else under /skills with 404, and leaves other paths alone", async () => {
    for (const p of ["/skills/nope", "/skills/missing/SKILL.md", "/skills/manifest.json/", "/skills/porchsite-website-helper/"]) expect((await get(p)).status).toBe(404);
    expect((await get("/skills/manifest.json", "POST")).status).toBe(404);
    expect((await get("/skills/manifest.json", "DELETE")).status).toBe(404);
    expect(await skills(new Request("https://porchsite.dev/skillsx"), env)).toBeNull();
    expect(await skills(new Request("https://porchsite.dev/docs/"), env)).toBeNull();
  });
});
