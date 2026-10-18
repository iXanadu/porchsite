import { expect, it, vi } from "vitest";
import { dateFormatter, dateString, dateMemo } from "../src/date-format";

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

it("perf5_date_memo: timestamp, canonical options, zone and hourCycle stay request-local",()=>{
 const original=Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype,'format')!.get!;let calls=0;
 const spy=vi.spyOn(Intl.DateTimeFormat.prototype as {format:unknown},'format','get').mockImplementation(function(this:Intl.DateTimeFormat){const format=original.call(this);return (date?:number|Date)=>{calls++;return format(date);};});
 try{const memo=dateMemo(),date=new Date('2026-03-08T07:00:00Z');
 const first=memo(date,{month:'short',day:'numeric'});expect(memo(new Date(date),{day:'numeric',month:'short'})).toBe(first);expect(calls).toBe(1);
 memo(date,{month:'short',day:'numeric'},'America/Chicago');memo(date,{hour:'numeric',hourCycle:'h23'});memo(date,{hour:'numeric',hourCycle:'h11'});memo(new Date(date.getTime()+86400000),{month:'short',day:'numeric'});expect(calls).toBe(5);
 dateMemo()(date,{month:'short',day:'numeric'});expect(calls).toBe(6);expect(memo(new Date(NaN),{month:'long'})).toBe('Invalid Date');
 }finally{spy.mockRestore();}
});
