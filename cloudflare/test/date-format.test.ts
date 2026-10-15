import { expect, it } from "vitest";
import { dateFormatter, dateString } from "../src/date-format";

it("preserves native date and time strings across year and daylight-saving boundaries", () => {
  for (const stamp of ["2025-12-31T23:59:00Z", "2026-03-08T07:59:00Z", "2026-03-08T08:01:00Z", "2026-11-01T07:01:00Z"]) {
    const date = new Date(stamp);
    for (const timeZone of ["UTC", "America/Chicago", "Europe/London", "Asia/Kolkata"]) {
      const options = { month: "short", day: "numeric" } as const;
      expect(dateString(date, options, timeZone)).toBe(date.toLocaleDateString("en-US", { ...options, timeZone }));
      const clock = { hour: "numeric", minute: "2-digit" } as const;
      expect(dateString(date, clock, timeZone)).toBe(date.toLocaleTimeString("en-US", { ...clock, timeZone }));
    }
  }
  expect(dateString(new Date(NaN), { month: "long", day: "numeric" })).toBe("Invalid Date");
});

it("keys reuse by options and timezone and bounds retained formatters", () => {
  const original = dateFormatter({ month: "long", day: "numeric" });
  expect(dateFormatter({ day: "numeric", month: "long" })).toBe(original);
  expect(dateFormatter({ month: "long", day: "numeric" }, "America/Chicago")).not.toBe(original);
  for (const timeZone of Intl.supportedValuesOf("timeZone").slice(0, 33)) dateFormatter({}, timeZone);
  const recreated = dateFormatter({ month: "long", day: "numeric" });
  expect(recreated).not.toBe(original);
  const date = new Date("2026-10-15T12:00:00Z");
  expect(recreated.format(date)).toBe(original.format(date));
  expect(() => dateFormatter({}, "Invalid/Zone")).toThrow(RangeError);
});
