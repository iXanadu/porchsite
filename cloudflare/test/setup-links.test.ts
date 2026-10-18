// Claiming a fresh site from a link: /setup?code=... fills the code in,
// codes can be stored in the database with an expiry, a new one replaces the
// old, and once the site is claimed every code is dead.
// Port-matched: server/tests/app/test_web_setup_links.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { ApiError } from "../src/errors";
import * as owner from "../src/owner";
import { handle, setupQueryRefusal } from "../src/routes";

const e = env as unknown as Env;
const db = e.DB;
let cookie = "";
const at = (path: string, init?: RequestInit) => handle(new Request(`https://site.example${path}`, init), e);
async function post(path: string, body: unknown): Promise<Response> {
  const r = await at(path, { method: "POST", headers: { "content-type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  const set = r.headers.get("Set-Cookie");
  if (set) cookie = set.split(";")[0];
  return r;
}
const options = (code: string) => post("/setup/options", { code, name: "Sam" });

async function unclaimed() {
  for (const t of ["passkeys", "sessions", "owner", "setup_codes", "challenges"]) await db.prepare(`DELETE FROM ${t}`).run();
}
async function claimed() {
  await db.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
}
async function refusal(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (x) {
    return x as ApiError;
  }
  throw new Error("not refused");
}

describe("claiming from a setup link", () => {
  it("fills the code in from the link and leaks nothing", async () => {
    await unclaimed();
    const page = await at("/setup?code=abcde-fghjk");
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('name="code" autocomplete="off" required value="abcde-fghjk"');
    expect(text).toContain("Your setup code is filled in.");
    expect(text).toContain('history.replaceState(null, "", location.pathname)');
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const bare = await at("/setup");
    const bareText = await bare.text();
    expect(bareText).toContain("required><label>Your name");
    expect(bareText).toContain("Enter the setup code you were given");
    expect(bare.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(bare.headers.get("Cache-Control")).toBe("no-store");
    const odd = await at(`/setup?code=${encodeURIComponent('"><script>')}`);
    expect(await odd.text()).toContain('value="&#34;&#62;&#60;script&#62;"');
    expect((await at("/login")).status).toBe(303);
  });

  it("accepts a stored code, beside the deploy-time one", async () => {
    await unclaimed();
    const expiresAt = await owner.issueSetupCode(db, "stored-code-one", 24);
    expect(expiresAt > new Date().toISOString()).toBe(true);
    const row = await db.prepare("SELECT code_hash FROM setup_codes").first<{ code_hash: string }>();
    expect(row!.code_hash).not.toBe("stored-code-one");
    const ok = await options(" stored-code-one ");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).options.rp).toEqual({ name: "Sam", id: "site.example" });
    expect((await options("test-setup-code")).status).toBe(200);
  });

  it("refuses wrong and expired codes", async () => {
    await unclaimed();
    await owner.issueSetupCode(db, "stored-code-two", 24);
    const wrong = await options("nope");
    expect([wrong.status, ((await wrong.json()) as any).error]).toEqual([403, "bad_code"]);
    await db.prepare("UPDATE setup_codes SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    const late = await options("stored-code-two");
    expect([late.status, ((await late.json()) as any).error]).toEqual([403, "code_expired"]);
    const none = await refusal(owner.setupOptions(db, new Request("https://site.example/setup/options"), undefined, "nope", "Sam"));
    expect([none.status, none.code]).toEqual([503, "no_setup_code"]);
  });

  it("lets a new link replace the old", async () => {
    await unclaimed();
    await owner.issueSetupCode(db, "old-link-code", 24);
    expect((await options("old-link-code")).status).toBe(200);
    await owner.issueSetupCode(db, "new-link-code", 24);
    expect((await db.prepare("SELECT count(*) AS n FROM setup_codes").first<{ n: number }>())!.n).toBe(1);
    const done = await post("/setup/verify", {});
    expect([done.status, ((await done.json()) as any).error]).toEqual([403, "code_expired"]);
    const old = await options("old-link-code");
    expect([old.status, ((await old.json()) as any).error]).toEqual([403, "bad_code"]);
    expect((await options("new-link-code")).status).toBe(200);
  });

  it("refuses every code once the site is claimed", async () => {
    await unclaimed();
    await owner.issueSetupCode(db, "before-claim", 24);
    await claimed();
    for (const code of ["before-claim", "test-setup-code"]) {
      const r = await options(code);
      expect([code, r.status, ((await r.json()) as any).error]).toEqual([code, 409, "claimed"]);
    }
    const again = await refusal(owner.issueSetupCode(db, "after-claim", 24));
    expect(again.code).toBe("claimed");
    const page = await at("/setup?code=before-claim");
    expect(page.status).toBe(303);
    expect(page.headers.get("Location")).toBe("https://site.example/login");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
  });
});

// RA-9 introduces fragment links; query links remain accepted in this release.
it("keeps the fragment out of server HTML and clears it before submit",async()=>{
 await unclaimed();const code='fragment-only-credential';const r=await at('/setup#code='+code),body=await r.text();
 expect(r.status).toBe(200);expect(body).not.toContain(code);expect(body).toContain('<form method="post" action="/setup/options">');expect(body).toContain('new URLSearchParams(location.hash.slice(1))');expect(body).toContain('input.value = code.trim().slice(0, 200)');
 expect(body.indexOf('history.replaceState')).toBeLessThan(body.indexOf('await fetch('));expect(body).not.toContain('innerHTML');
 expect(r.headers.get('Cache-Control')).toBe('no-store');expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
 const old=await at('/setup?code=legacy-code');expect(await old.text()).toContain('value="legacy-code"');
});

it("pins the next-release query cutoff without reflecting a credential",async()=>{
 for(const query of ['code=','code=credential-canary','code=%3Cscript%3E','code=a&code=b']){
  const r=setupQueryRefusal(new Request('https://site.example/setup?'+query),false)!;
  expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'code_in_url',message:'This setup link is no longer supported. Ask for a fresh link or enter the code manually.'});
  expect(r.headers.get('Cache-Control')).toBe('no-store');expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');expect(r.headers.get('Location')).toBeNull();
 }
 expect(setupQueryRefusal(new Request('https://site.example/setup?code=legacy'))).toBeNull();
 expect(setupQueryRefusal(new Request('https://site.example/setup'),false)).toBeNull();
});
