// Importing content from a file (SPEC §5): an assistant that can't reach the
// site writes one file; the owner uploads it on /review/import; it becomes one
// approval request after every item is checked.
// Port-matched: server/tests/app/test_web_import.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 128, 0, 0, 1, 224, ...new Array(40).fill(0)]);
const bundle = (items: unknown[], images: Record<string, string> = {}) => JSON.stringify({ porchsite_import: 1, from: "Dot", note: "The reunion site.", items, images });

async function signedIn(): Promise<string> {
  const token = "import-session-token";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hash = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await e.DB.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
  await e.DB.prepare("INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, '2026-10-10', '2099-01-01')").bind(hash).run();
  return `__Host-sk_owner=${token}`;
}

describe("import", () => {
  it("turns a file into one approval request after every item is checked", async () => {
    const cookie = await signedIn();
    const page = await (await handle(new Request("https://site.example/review/import", { headers: { Cookie: cookie } }), e)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1];
    const upload = (text: string) => {
      const f = new FormData();
      f.set("csrf", csrf);
      f.set("file", new File([text], "site.json", { type: "application/json" }));
      return handle(new Request("https://site.example/review/import", { method: "POST", body: f, headers: { Cookie: cookie } }), e);
    };
    const good = bundle(
      [
        { kind: "site", data: { title: "Rams '76", tagline: "Fifty years on" } },
        { kind: "entry", data: { title: "Banquet", date: "2026-10-09", body: "![The banquet hall](image:hall.png)", cover: "image:hall.png", cover_alt: "The hall" } },
        { kind: "card", data: { name: "Committee", description: "Who ran it." } },
      ],
      { "hall.png": btoa(String.fromCharCode(...PNG)) },
    );
    const r = await upload(good);
    expect(r.status).toBe(303);
    const aid = r.headers.get("Location")!.split("/").pop()!;
    const a = await approvals.get(e.DB, aid);
    expect([a.requested_by, a.note, a.items.length]).toEqual(["assistant:Dot", "The reunion site.", 3]);
    const entry = await content.getItem(e.DB, a.items[1].id);
    expect(String(entry.data.cover)).toMatch(/^\/media\/[0-9a-f]{32}\.png$/);
    expect(entry.data.body).toBe(`![The banquet hall](${entry.data.cover})`);

    const before = (await content.allItems(e.DB)).length;
    const bad = await upload(bundle([{ kind: "entry", data: { title: "No date" } }, { kind: "card", data: { name: "Fine", description: "All good." } }]));
    expect(bad.status).toBe(422);
    const badText = await bad.text();
    expect(badText).toContain("1 item in the file can&#39;t be used as it stands.");
    expect(badText).toContain("<li>Item 1:");
    expect((await content.allItems(e.DB)).length).toBe(before);

    const missing = await (await upload(bundle([{ kind: "entry", data: { title: "x", date: "2026-10-09", cover: "image:nope.jpg" } }]))).text();
    expect(missing).toContain("nope.jpg");
    expect(await (await upload('{"items": []}')).text()).toContain("Porchsite import file");
  });
});
