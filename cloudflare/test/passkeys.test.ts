// The owner's passkey, end to end with a software key (SPEC §5): claim the
// site, sign in, add a second passkey from a link, and refuse what doesn't
// check out. Port-matched: server/tests/app/test_web_passkeys.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import * as owner from "../src/owner";
import { handle } from "../src/routes";
import { SoftKey } from "./softkey";

const e = env as unknown as Env;
const db = e.DB;
const ORIGIN = "https://site.example";
const jar = new Map<string, string>();
const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function at(path: string, init: RequestInit = {}): Promise<Response> {
  const r = await handle(new Request(`${ORIGIN}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookies() } }), e);
  for (const c of r.headers.getSetCookie?.() ?? [r.headers.get("Set-Cookie") ?? ""]) {
    const m = /^([^=;]+)=([^;]*)/.exec(c);
    if (m) {
      if (m[2]) jar.set(m[1], m[2]);
      else jar.delete(m[1]);
    }
  }
  return r;
}
const post = (path: string, body: unknown) => at(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("passkeys", () => {
  it("claims the site, signs in, adds a second passkey, and refuses a bad signature", async () => {
    for (const t of ["passkeys", "sessions", "owner", "setup_codes", "challenges"]) await db.prepare(`DELETE FROM ${t}`).run();
    const key = await SoftKey.make();

    // Claim.
    const opts = (await (await post("/setup/options", { code: e.SETUP_CODE, name: "Sam" })).json()) as { options: any };
    const claimed = await post("/setup/verify", await key.create(opts.options, ORIGIN));
    expect(claimed.status).toBe(200);
    expect((await at("/review")).status).toBe(200);
    expect(await owner.passkeyCount(db)).toBe(1);

    // Sign out, then sign in with the same key.
    jar.delete("__Host-sk_owner");
    expect((await at("/review")).status).toBe(303);
    const login = (await (await post("/login/options", {})).json()) as { options: any };
    expect((await post("/login/verify", await key.get(login.options, ORIGIN))).status).toBe(200);
    expect((await at("/review")).status).toBe(200);
    expect(await db.prepare("SELECT counter FROM passkeys").first("counter")).toBe(1);

    // A signature that doesn't match is refused, and doesn't sign anyone in.
    jar.delete("__Host-sk_owner");
    const again = (await (await post("/login/options", {})).json()) as { options: any };
    const forged = await key.get(again.options, ORIGIN);
    const sig = forged.response.signature;
    forged.response.signature = sig.slice(0, 20) + (sig[20] === "A" ? "B" : "A") + sig.slice(21);
    const refused = await post("/login/verify", forged);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "not_verified" });
    expect((await at("/review")).status).toBe(303);

    // Garbage, or a response made for another address, is refused the same way, never a 500.
    const junk = (await (await post("/login/options", {})).json()) as { options: any };
    const bad = await key.get(junk.options, ORIGIN);
    bad.response.clientDataJSON = bad.response.clientDataJSON.slice(0, -2) + "AA";
    expect((await post("/login/verify", bad)).status).toBe(403);
    const other = (await (await post("/login/options", {})).json()) as { options: any };
    expect((await post("/login/verify", await key.get(other.options, "https://elsewhere.example"))).status).toBe(403);

    // A second passkey from a one-time link.
    const login2 = (await (await post("/login/options", {})).json()) as { options: any };
    await post("/login/verify", await key.get(login2.options, ORIGIN));
    const link = await owner.createPasskeyLink(db);
    const phone = await SoftKey.make();
    const add = (await (await post(`/passkey/${link.token}/options`, {})).json()) as { options: any };
    expect(add.options.excludeCredentials.map((c: { id: string }) => c.id)).toHaveLength(1);
    expect((await post(`/passkey/${link.token}/verify`, await phone.create(add.options, ORIGIN))).status).toBe(200);
    expect(await owner.passkeyCount(db)).toBe(2);
    jar.delete("__Host-sk_owner");
    const login3 = (await (await post("/login/options", {})).json()) as { options: any };
    expect((await post("/login/verify", await phone.get(login3.options, ORIGIN))).status).toBe(200);
  });
});
