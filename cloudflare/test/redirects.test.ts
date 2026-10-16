// Missing pages that moved: trailing slash and old stream addresses.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import * as site from "../src/site";

const v = site.view(
  {
    streams: [
      { id: "journal", path: "reports" },
      { id: "writing" },
    ],
  },
  [
    { id: "a", kind: "entry", slug: "first", data: { title: "First", date: "2026-10-01", stream: "journal", tags: [] } },
    { id: "b", kind: "entry", slug: "essay", data: { title: "Essay", date: "2026-10-02", stream: "writing", tags: [] } },
  ],
);

describe("redirectFor", () => {
  it("adds the trailing slash to real pages only", () => {
    expect(site.redirectFor(v, "/reports")).toBe("/reports/");
    expect(site.redirectFor(v, "/writing/essay")).toBe("/writing/essay/");
    expect(site.redirectFor(v, "/reports/tags/boats")).toBe("/reports/tags/boats/");
    expect(site.redirectFor(v, "/review")).toBeNull();
    expect(site.redirectFor(v, "/writing/nothing")).toBeNull();
    expect(site.redirectFor(v, "/reports/")).toBeNull();
  });

  it("sends a moved stream's old address to its new one", () => {
    expect(site.redirectFor(v, "/journal/")).toBe("/reports/");
    expect(site.redirectFor(v, "/journal")).toBe("/reports/");
    expect(site.redirectFor(v, "/journal/first/")).toBe("/reports/first/");
    expect(site.redirectFor(v, "/journal/first")).toBe("/reports/first/");
    expect(site.redirectFor(v, "/journal/gone/")).toBeNull();
  });
});

describe("www", () => {
  it("sends www.<domain> to <domain>", async () => {
    const worker = (await import("../src/index")).default;
    const r = await worker.fetch(new Request("https://www.example.com/pages/x/?a=1"), env as never, {} as never);
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://example.com/pages/x/?a=1");
  });
});
