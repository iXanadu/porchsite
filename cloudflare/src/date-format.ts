/** Bounded immutable formatters; timestamps and rendered values stay per request. */
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTERS = 32;

export function dateFormatter(options: Intl.DateTimeFormatOptions, timeZone = "UTC"): Intl.DateTimeFormat {
  const configured = { ...options, timeZone };
  const key = JSON.stringify(Object.entries(configured).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", configured);
    if (formatters.size === MAX_FORMATTERS) formatters.delete(formatters.keys().next().value!);
    formatters.set(key, formatter);
  }
  return formatter;
}

/** Date.toLocaleDateString returns this string, rather than throwing, for invalid dates. */
export function dateString(date: Date, options: Intl.DateTimeFormatOptions, timeZone = "UTC"): string {
  return Number.isNaN(date.getTime()) ? "Invalid Date" : dateFormatter(options, timeZone).format(date);
}

// Prepare fixed/default-zone formatters in global scope. A site's configured
// timezone comes from D1, so other zones enter the bounded cache on first use.
for (const options of [
  {},
  { month: "short", day: "numeric" },
  { month: "long", day: "numeric", year: "numeric" },
  { weekday: "long", month: "long", day: "numeric", year: "numeric" },
  { weekday: "short", month: "short", day: "numeric" },
  { timeZoneName: "short" },
  { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" },
  { year: "numeric", month: "2-digit", day: "2-digit" },
  { hour: "numeric", minute: "2-digit" },
] as Intl.DateTimeFormatOptions[]) dateFormatter(options).format(new Date(0));
