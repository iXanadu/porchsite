// The owner's words over a look's own (SPEC §3 site `strings`, TEMPLATES §3).
// Port-matched: server/tests/spec/test_strings.py.
import { describe, expect, it } from "vitest";
import { hoursView } from "../src/blocks";
import { validate } from "../src/content";
import * as site from "../src/site";
import { STRINGS, stringsOf } from "../src/strings";
import * as theme from "../src/theme";

const s = validate("site", { title: "Kettle", footer_line: "Fait main.", strings: { back_to_top: "Haut de page", not_found_title: "Introuvable", all_of: "", open_now: "Ouvert" } });
const v = site.view(s, []);

describe("strings", () => {
  it("lays the owner's words over the defaults; an empty one keeps the default", () => {
    const t = stringsOf(s);
    expect(t.back_to_top).toBe("Haut de page");
    expect(t.all_of).toBe(STRINGS.all_of);
    expect(t.read_full_entry).toBe(STRINGS.read_full_entry);
    expect((theme.homeView(v, "1", "https://site.example").strings as Record<string, string>).back_to_top).toBe("Haut de page");
    expect((theme.notFoundView(v, "1", "https://site.example").meta as { title: string }).title).toBe("Introuvable · Kettle");
  });

  it("reaches the blocks", () => {
    const h = { weekly: [{ day: "mon", open: "09:00", close: "17:00", closed: false }], exceptions: [], note: "" };
    expect(hoursView(h, "UTC", new Date("2026-10-12T10:00:00Z"), stringsOf(s)).status).toBe("Ouvert · until 5:00 PM");
  });

  it("refuses a name no look uses", () => {
    expect(() => validate("site", { strings: { back_to_tpo: "x" } })).toThrow();
  });

  it("the built-in look uses the footer line and the words for Not found", async () => {
    expect(await site.home(v).text()).toContain("<footer>Fait main.</footer>");
    const nf = await site.notFound(v).text();
    expect(nf).toContain("<title>Introuvable · Kettle</title>");
    expect(nf).toContain("<h1>Introuvable</h1>");
  });
});
