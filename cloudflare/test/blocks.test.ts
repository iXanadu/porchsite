// Structured blocks, made display-ready in the site's timezone, and palettes.
import { describe, expect, it } from "vitest";
import { contactView, contrast, eventView, hoursView, noticeView, paletteCss, paletteProblems } from "../src/blocks";
import * as theme from "../src/theme";
import { THEMES } from "../src/themes.gen";

const tz = "America/Chicago";
// Thursday Oct 15 2026, 10:30 AM in Chicago.
const thu = new Date("2026-10-15T15:30:00Z");
const hours = {
  weekly: [
    { day: "mon", open: "", close: "", closed: true },
    { day: "tue", open: "11:00", close: "14:00", closed: false },
    { day: "tue", open: "17:00", close: "21:00", closed: false },
    { day: "wed", open: "09:00", close: "17:00", closed: false },
    { day: "thu", open: "09:00", close: "17:00", closed: false },
    { day: "fri", open: "09:00", close: "17:00", closed: false },
  ],
  exceptions: [
    { from: "2026-11-26", to: "", label: "Thanksgiving", open: "", close: "", closed: true },
    { from: "2026-12-31", to: "", label: "New Year's Eve", open: "09:00", close: "13:00", closed: false },
    { from: "2026-08-01", to: "", label: "Long gone", open: "", close: "", closed: true },
  ],
  note: "Kitchen closes 30 minutes early.",
};

describe("hours", () => {
  it("prints the week, today, and whether it's open now", () => {
    const h = hoursView(hours, tz, thu);
    expect(h.days.map((d: { day: string; hours: string }) => `${d.day}: ${d.hours}`)).toEqual([
      "Monday: Closed",
      "Tuesday: 11:00 AM – 2:00 PM, 5:00 PM – 9:00 PM",
      "Wednesday: 9:00 AM – 5:00 PM",
      "Thursday: 9:00 AM – 5:00 PM",
      "Friday: 9:00 AM – 5:00 PM",
      "Saturday: Closed",
      "Sunday: Closed",
    ]);
    expect(h.days[3].today).toBe(true);
    expect(h.status).toBe("Open now · until 5:00 PM");
    expect(hoursView(hours, tz, new Date("2026-10-17T15:30:00Z")).status).toBe("Closed now · opens Tue 11:00 AM");
  });

  it("shows holidays for the next 60 days only, and they change the day", () => {
    const h = hoursView(hours, tz, new Date("2026-11-20T15:00:00Z"));
    expect(h.exceptions).toEqual([
      { label: "Thanksgiving", when: "Thu, Nov 26", hours: "Closed" },
      { label: "New Year's Eve", when: "Thu, Dec 31", hours: "9:00 AM – 1:00 PM" },
    ]);
    expect(hoursView(hours, tz, new Date("2026-10-15T15:00:00Z")).exceptions).toEqual([{ label: "Thanksgiving", when: "Thu, Nov 26", hours: "Closed" }]);
    expect(hoursView(hours, tz, new Date("2026-11-26T16:00:00Z")).status).toBe("Closed now · opens Fri 9:00 AM");
  });
});

describe("notice, contact, events", () => {
  it("drops a notice after its day", () => {
    expect(noticeView({ text: "Closed today", until: "2026-10-15" }, tz, thu)).toEqual({ has: true, text: "Closed today" });
    expect(noticeView({ text: "Closed today", until: "2026-10-14" }, tz, thu).has).toBe(false);
  });

  it("makes contact links", () => {
    const c = contactView({ phone: "+1 202 555 0100", email: "hi@example.com", address: { line1: "12 Example St", line2: "", city: "Springfield", region: "IL", postcode: "62701", country: "" }, map_link: "", social: [] });
    expect(c.phone_href).toBe("tel:+12025550100");
    expect(c.address_one_line).toBe("12 Example St, Springfield, IL 62701");
  });

  it("says when and where, and whether it's past", () => {
    const ev = { start: "2026-06-13T18:00", end: "2026-06-13T22:00", place: { name: "The Harbor Hall", address: "", map_link: "" }, rsvp: { label: "RSVP", link: "https://example.com/rsvp", deadline: "2026-06-01" }, schedule: [{ time: "18:30", title: "Dinner", note: "" }], status: "changed" };
    const e = eventView(ev, tz, new Date("2026-06-01T12:00:00Z"));
    expect(e.when).toBe("Saturday, June 13, 2026 · 6:00 PM – 10:00 PM CT");
    expect(e.rsvp_deadline).toBe("RSVP by Monday, June 1, 2026");
    expect(e.schedule[0].time).toBe("6:30 PM");
    expect(e.is_past).toBe(false);
    expect(e.status).toBe("Changed");
    expect(eventView(ev, tz, new Date("2026-06-14T12:00:00Z")).is_past).toBe(true);
  });
});

describe("palettes", () => {
  it("refuses unreadable colours", () => {
    expect(contrast("#ffffff", "#000000")).toBe(21);
    const bad = { pale: { title: "Pale", colors: { bg: "#ffffff", ink: "#999999", muted: "#555555", accent: "#00647f", "accent-2": "#a8470f", line: "#cccccc", "on-accent": "#ffffff" } } };
    expect(paletteProblems(bad)).toEqual(["palette pale: ink on bg is 2.85:1, needs 4.5:1"]);
    expect(paletteProblems(THEMES["product-page"].manifest.palettes as Record<string, any>)).toEqual([]);
  });

  it("adds the chosen palette after the theme's stylesheet", async () => {
    const css = await theme.staticFile(THEMES["product-page"], "site.css", "sunset")!.text();
    expect(css.trimEnd().endsWith("--on-accent:#ffffff}")).toBe(true);
    expect(css).toContain(":root{--bg:#fdf5ec");
    expect(paletteCss(THEMES["product-page"].manifest.palettes as Record<string, any>, "nope")).toContain("--bg:#f3f2f2");
  });
});

describe("events in the theme view", () => {
  it("formats the event, not the raw stored one", async () => {
    const site = await import("../src/site");
    const { MODELS } = await import("../src/models");
    const s = MODELS.site.parse({ title: "Spring gathering", streams: [{ id: "events", title: "Events", layout: "list" }], timezone: "America/Chicago" });
    const ev = MODELS.entry.parse({ stream: "events", title: "Dinner", date: "2027-06-12", event: { start: "2027-06-12T18:00", place: { name: "The Harbor Hall" } } });
    const v = site.view(s, [{ id: "e1", kind: "entry", slug: "dinner", data: ev }]);
    v.now = new Date("2027-01-01T12:00:00Z");
    const home = theme.homeView(v, "1", "https://example.com");
    const sec = home.sections.find((x: { is_entries: boolean }) => x.is_entries);
    expect(sec.upcoming[0].event.has).toBe(true);
    expect(sec.upcoming[0].event.when).toBe("Saturday, June 12, 2027 · 6:00 PM CT");
    expect(MODELS.card.parse({ name: "Commission", description: "Write to me.", link: "mailto:me@example.com" }).link).toBe("mailto:me@example.com");
  });
});
