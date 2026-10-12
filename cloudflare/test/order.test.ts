// Same-day entries and notes: the one created later comes first (SPEC Streams).
import { describe, expect, it } from "vitest";
import * as site from "../src/site";

const entry = (id: string, date: string, created: string) => ({
  id,
  kind: "entry",
  slug: id,
  data: { title: id, date, stream: "journal", tags: [] },
  created,
});
const note = (id: string, date: string, created: string) => ({ id, kind: "note", slug: null, data: { text: id, date }, created });

describe("view order", () => {
  it("puts the later-created of same-day items first, whatever order the rows come in", () => {
    const rows = [
      entry("a", "2026-10-01", "2026-10-01T09:00:00Z"),
      entry("b", "2026-10-02", "2026-10-02T08:00:00Z"),
      entry("c", "2026-10-02", "2026-10-02T10:00:00Z"),
      note("n1", "2026-10-02", "2026-10-02T07:00:00Z"),
      note("n2", "2026-10-02", "2026-10-02T11:00:00Z"),
    ];
    for (const r of [rows, [...rows].reverse()]) {
      const v = site.view({ streams: [{ id: "journal" }] }, r);
      expect(v.entries.map((e) => e.id)).toEqual(["c", "b", "a"]);
      expect(v.notes.map((n) => n.id)).toEqual(["n2", "n1"]);
    }
  });

  it("keeps the rows' order when there is no creation time (a look's sample)", () => {
    const rows = [entry("x", "2026-10-02", ""), entry("y", "2026-10-02", "")];
    const v = site.view({ streams: [{ id: "journal" }] }, rows);
    expect(v.entries.map((e) => e.id)).toEqual(["x", "y"]);
  });
});
