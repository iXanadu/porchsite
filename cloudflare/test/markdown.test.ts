import { describe, expect, it } from "vitest";
import text from "../../spec/markdown-cases.json?raw";
import { markdown } from "../src/html";

// The shared table: the server edition's tests read the same file, so the two
// renderers can't drift apart.
const cases = JSON.parse(text) as { name: string; markdown: string; html: string }[];

describe("markdown (spec/markdown-cases.json)", () => {
  it("has the shared cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });
  it.each(cases)("$name", ({ markdown: src, html }) => {
    expect(markdown(src).html).toBe(html);
  });
});
