// The owner says what kind a card group is; looks read it from by_group
// (TEMPLATES §3). Port-matched: server/tests/spec/test_card_groups.py.
import { describe, expect, it } from "vitest";
import { validate } from "../src/content";
import * as site from "../src/site";
import * as theme from "../src/theme";

const card = (id: string, name: string, group: string) => ({ id, kind: "card", slug: null, data: validate("card", { name, description: "x", group }) });

describe("card groups", () => {
  it("carries each group's style and a flag for it", () => {
    const s = validate("site", { title: "Shop", card_groups: [{ name: "Questions", style: "faq" }, { name: "How it works", style: "steps" }] });
    const v = site.view(s, [card("c1", "Do you deliver?", "Questions"), card("c2", "Order", "How it works"), card("c3", "Bread", "Menu")]);
    const sec = (theme.homeView(v, "1", "https://site.example").sections as any[]).find((x) => x.is_cards);
    const by = Object.fromEntries(sec.by_group.map((g: any) => [g.label, g]));
    expect(by.Questions).toMatchObject({ style: "faq", is_faq: true, is_steps: false });
    expect(by["How it works"]).toMatchObject({ style: "steps", is_steps: true });
    expect(by.Menu).toMatchObject({ style: "", is_faq: false, is_steps: false, is_reviews: false, is_list: false });
  });

  it("refuses an unknown style and a group named twice", () => {
    expect(() => validate("site", { card_groups: [{ name: "A", style: "gallery" }] })).toThrow();
    expect(() => validate("site", { card_groups: [{ name: "A", style: "faq" }, { name: "A", style: "list" }] })).toThrow();
  });
});
