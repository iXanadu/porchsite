// Shared fixture and matching assertions: server/tests/spec/test_playbook.py.
import { describe, expect, it } from "vitest";
import text from "../../spec/playbook-cards.json?raw";
import { validate } from "../src/content";
import { view } from "../src/site";
import { homeView, render } from "../src/theme";
import { THEMES } from "../src/themes.gen";

const fixture = JSON.parse(text);
describe("Playbook cards", () => {
  it.each([false, true])("renders aside cards without exposing hidden links (regular=%s)", (withRegular) => {
    const rows = fixture.items.map((row: any) => ({ ...row, data: validate("card", row.data) }));
    if (withRegular) rows.push({ id: "regular", kind: "card", slug: null, data: validate("card", { name: "Ordinary reference", description: "Another reference.", group: "Other", link: "https://example.com/ordinary" }) });
    const html = render(THEMES.playbook, "home", homeView(view(validate("site", fixture.site), rows), "1", "https://example.com"));
    expect(html).toContain("Important reference");
    expect(html).toContain('href="https://example.com/reference"');
    expect(html).toContain("Mentioned reference");
    expect(html).not.toContain("hidden-mention");
    expect(html).not.toContain("Private reference");
    expect(html).not.toContain("hidden-private");
    if (withRegular) {
      expect(html).toContain("Ordinary reference");
      expect(html).toContain('href="https://example.com/ordinary"');
    }
  });
});
