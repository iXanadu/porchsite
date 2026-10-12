// Adding a passkey on another device or address: a one-time link from a signed-in owner.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { ApiError } from "../src/errors";
import * as owner from "../src/owner";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;

async function claimed() {
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AAAAAAAAAAAAAAAAAAAAAA', '2026-10-10')").run();
  await db.prepare("INSERT OR IGNORE INTO passkeys (id, public_key, counter, created_at) VALUES ('old-key', x'00', 0, '2026-10-10')").run();
}

describe("passkey links", () => {
  it("are made only by a signed-in owner", async () => {
    await claimed();
    const page = await handle(new Request("https://site.example/review/passkeys"), e);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toContain("/login");
  });

  it("open a page on any address of the site, then register for that address", async () => {
    await claimed();
    const { token } = await owner.createPasskeyLink(db);
    const page = await handle(new Request(`https://new.example/passkey/${token}`), e);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Add a passkey here");

    const r = await handle(new Request(`https://new.example/passkey/${token}/options`, { method: "POST" }), e);
    expect(r.status).toBe(200);
    const { options } = (await r.json()) as { options: { rp: { id: string }; excludeCredentials: { id: string }[] } };
    expect(options.rp.id).toBe("new.example");
    expect(options.excludeCredentials.map((c) => c.id)).toContain("old-key");
  });

  it("refuse a link that has expired or been used", async () => {
    await claimed();
    const { token } = await owner.createPasskeyLink(db);
    await db.prepare("UPDATE passkey_links SET used_at = '2026-10-10'").run();
    expect((await handle(new Request(`https://site.example/passkey/${token}`), e)).status).toBe(410);
    const err = await owner.addOptions(db, new Request("https://site.example/"), token).catch((x) => x);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("link_used");
    expect((await handle(new Request(`https://site.example/passkey/${"x".repeat(32)}`), e)).status).toBe(410);
  });
});
