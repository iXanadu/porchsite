// Putting the site back to a publish from before the site's text was first
// published leaves that text as it is (SPEC §5). Port-matched:
// server/tests/app/test_web_revert_site.py.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as approvals from "../src/approvals";
import * as content from "../src/content";
import type { Env } from "../src/env";
import * as history from "../src/history";

const db = (env as unknown as Env).DB;
const who = "assistant:Helper";

async function publish(ids: string[]) {
  const req = await approvals.request(db, who, ids, "");
  await approvals.decide(db, req.id, Object.fromEntries(ids.map((id) => [id, { decision: "approve" }])), "");
}

describe("whole-site revert, early publishes", () => {
  it("leaves the site's text alone when going back to before it was first published", async () => {
    const a = await content.createItem(db, who, "entry", { title: "First pot", date: "2026-10-01" }, undefined);
    await publish([a.id]);
    const first = (await history.publishes(db))[0].id;
    const s = await content.createItem(db, who, "site", { title: "Kettle", tagline: "Tea." }, undefined);
    const b = await content.createItem(db, who, "entry", { title: "Second pot", date: "2026-10-02" }, undefined);
    await publish([s.id, b.id]);
    const ids = (await history.plan(db, first)).changes.map((c) => c.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(s.id);
  });
});
