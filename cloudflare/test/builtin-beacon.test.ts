// The built-in look carries the kit's beacon, so a site on it is counted (SPEC §8).
// Port-matched: server/tests/app/test_web_builtin_beacon.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handle } from "../src/routes";

const e = env as unknown as Env;
const at = (path: string) => handle(new Request(`https://site.example${path}`), e);

describe("built-in look beacon", () => {
  it("loads the beacon on its pages and lets it post to this site only", async () => {
    for (const [path, kind] of [["/", "home"], ["/nothing-here/", "notfound"]]) {
      const r = await at(path);
      const page = await r.text();
      expect(page).toContain(`<body data-kind="${kind}" data-id="">`);
      expect(page).toContain('<script src="/static/a.js" defer></script></body>');
      expect(r.headers.get("Content-Security-Policy")).toContain("script-src 'self'; connect-src 'self'");
    }
  });
});
