// A refusal is worded the same in both editions. Port-matched:
// server/tests/spec/test_problems.py (same table).
import { describe, expect, it } from "vitest";
import { validate } from "../src/content";

const CASES: [string, Record<string, unknown>, string, string][] = [
  ["site", { tagline: "x".repeat(161) }, "tagline", "Too big: expected string to have <=160 characters"],
  ["site", { title: "" }, "title", "Too small: expected string to have >=1 characters"],
  ["site", { tagline: 3 }, "tagline", "Invalid input: expected string, received number"],
  ["site", { links: {} }, "links", "Invalid input: expected array, received object"],
  ["site", { links: Array.from({ length: 9 }, () => ({ label: "a", url: "/a" })) }, "links", "Too big: expected array to have <=8 items"],
  ["card", { name: "A", sort: 1.5 }, "sort", "Invalid input: expected int, received number"],
  ["card", { name: "A", sort: "1" }, "sort", "Invalid input: expected number, received string"],
  ["card", { name: "A", sort: -1 }, "sort", "Too small: expected number to be >=0"],
  ["card", { name: "A", sort: 10001 }, "sort", "Too big: expected number to be <=10000"],
];

describe("problems", () => {
  it.each(CASES)("%s %j", (kind, data, field, problem) => {
    try {
      validate(kind, data);
      throw new Error("accepted");
    } catch (e: any) {
      expect(e.extra?.problems).toContainEqual({ field, problem });
    }
  });
});
