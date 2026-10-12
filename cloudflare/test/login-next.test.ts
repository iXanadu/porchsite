// After signing in, the owner lands where they were going: a connect
// request's own address survives, plain ":" and "/" and all; nothing else
// gets through. Port-matched: server/tests/app/test_web_passkey_links.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const login = async (next: string) => (await handle(new Request(`https://site.example/login?next=${encodeURIComponent(next)}`), e)).text();

describe("sign-in's next", () => {
  it("keeps a connect request, and refuses anything off the owner's pages", async () => {
    await e.DB.prepare("INSERT OR IGNORE INTO owner (id, name, user_handle, created_at) VALUES (1, 'Sam', 'AA', '2026-10-10')").run();
    const ask = "/authorize?response_type=code&scope=site:draft&redirect_uri=https://app.example/cb&state=a+b~c";
    expect(await login(ask)).toContain(`location.href = ${JSON.stringify(ask)}`);
    for (const bad of ["//evil.example", "/reviewer", "/review?</script><b>", '/review?"x', "/review\\x", "https://evil.example/review"]) {
      expect(await login(bad)).toContain('location.href = "/review"');
    }
  });
});
