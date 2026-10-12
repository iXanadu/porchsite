/**
 * The site's structured blocks (contact, hours, notice, events) made
 * display-ready for themes, in the site's timezone. Pages are rendered per
 * request, so "open now" and "upcoming" are true when the page is served,
 * with no script in the browser.
 */
import { BLOCK_STRINGS } from "./strings";

export { BLOCK_STRINGS };

type Data = Record<string, any>;

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

/** Now, as the site's wall clock: date YYYY-MM-DD, time HH:MM, weekday mon..sun. */
export function localNow(now: Date, timeZone: string): { date: string; time: string; day: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, day: String(parts.weekday).slice(0, 3).toLowerCase() };
}

export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const at = (d: string) => new Date(`${d}T12:00:00Z`);
const longDay = (d: string) => at(d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDay = (d: string) => at(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const addDays = (d: string, n: number) => new Date(at(d).getTime() + n * 86400_000).toISOString().slice(0, 10);
const weekdayOf = (d: string) => DAYS[(at(d).getUTCDay() + 6) % 7];
const zoneName = (timeZone: string, now: Date) =>
  (new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "UTC").replace(/^([ECMP])[SD]T$/, "$1T");

export function contactView(c: Data | undefined): Data {
  const a = c?.address ?? {};
  const cityLine = [a.city, [a.region, a.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const lines = [a.line1, a.line2, cityLine, a.country].filter(Boolean);
  const phone = String(c?.phone ?? "");
  return {
    has: !!(phone || c?.email || lines.length || (c?.social ?? []).length),
    phone,
    phone_href: phone ? `tel:${phone.replace(/[^+\d]/g, "")}` : "",
    email: c?.email ?? "",
    email_href: c?.email ? `mailto:${c.email}` : "",
    address_lines: lines.map((line) => ({ line })),
    address_one_line: lines.join(", "),
    has_address: lines.length > 0,
    map_link: c?.map_link ?? "",
    social: c?.social ?? [],
    has_social: (c?.social ?? []).length > 0,
  };
}

function hoursOn(h: Data, date: string): { closed: boolean; spans: { open: string; close: string }[]; label: string } {
  const ex = (h.exceptions ?? []).find((x: Data) => x.from <= date && date <= (x.to || x.from));
  if (ex) return { closed: ex.closed || !ex.open, spans: ex.closed || !ex.open ? [] : [{ open: ex.open, close: ex.close }], label: ex.label };
  const rows = (h.weekly ?? []).filter((r: Data) => r.day === weekdayOf(date));
  const spans = rows.filter((r: Data) => !r.closed && r.open && r.close).map((r: Data) => ({ open: r.open, close: r.close }));
  return { closed: spans.length === 0, spans, label: "" };
}

const spanText = (spans: { open: string; close: string }[]) => spans.map((s) => `${clock(s.open)} – ${clock(s.close)}`).join(", ");

export function hoursView(h: Data | undefined, timeZone: string, now: Date, t: Record<string, string> = BLOCK_STRINGS): Data {
  if (!h || !(h.weekly ?? []).length) return { has: false, days: [], exceptions: [], has_exceptions: false, open_now: false, status: "", note: "" };
  const n = localNow(now, timeZone);
  const days = DAYS.map((d) => {
    const rows = h.weekly.filter((r: Data) => r.day === d && !r.closed && r.open && r.close);
    return { day: DAY_NAMES[d], hours: rows.length ? spanText(rows) : t.closed, closed: !rows.length, today: d === n.day };
  });
  const today = hoursOn(h, n.date);
  const current = today.spans.find((s) => s.open <= n.time && n.time < s.close);
  let status: string;
  if (current) status = `${t.open_now} · ${t.until} ${clock(current.close)}`;
  else {
    const later = today.spans.find((s) => s.open > n.time);
    let next = later ? `${clock(later.open)}` : "";
    for (let i = 1; !next && i <= 7; i++) {
      const d = addDays(n.date, i);
      const o = hoursOn(h, d);
      if (!o.closed) next = `${shortDay(d).split(",")[0]} ${clock(o.spans[0].open)}`;
    }
    status = next ? `${t.closed_now} · ${t.opens} ${next}` : t.closed_now;
  }
  const horizon = addDays(n.date, 60);
  const exceptions = (h.exceptions ?? [])
    .filter((x: Data) => (x.to || x.from) >= n.date && x.from <= horizon)
    .sort((a: Data, b: Data) => a.from.localeCompare(b.from))
    .map((x: Data) => ({
      label: x.label,
      when: x.to && x.to !== x.from ? `${shortDay(x.from)} – ${shortDay(x.to)}` : shortDay(x.from),
      hours: x.closed || !x.open ? t.closed : spanText([{ open: x.open, close: x.close }]),
    }));
  return { has: true, days, exceptions, has_exceptions: exceptions.length > 0, open_now: !!current, status, note: h.note ?? "" };
}

export function noticeView(n: Data | undefined, timeZone: string, now: Date): Data {
  const text = String(n?.text ?? "");
  const shown = !!text && (!n?.until || n.until >= localNow(now, timeZone).date);
  return { has: shown, text: shown ? text : "" };
}

export function eventView(ev: Data | null | undefined, timeZone: string, now: Date, t: Record<string, string> = BLOCK_STRINGS): Data {
  if (!ev) return { has: false };
  const n = localNow(now, timeZone);
  const nowStamp = `${n.date}T${n.time}`;
  const [sd, st] = ev.start.split("T");
  const [ed, et] = ev.end ? ev.end.split("T") : [sd, ""];
  const zone = zoneName(timeZone, at(sd));
  const time = et && ed === sd ? `${clock(st)} – ${clock(et)} ${zone}` : `${clock(st)} ${zone}`;
  const when = ed !== sd && ev.end ? `${longDay(sd)}, ${clock(st)} – ${longDay(ed)}, ${clock(et)} ${zone}` : `${longDay(sd)} · ${time}`;
  return {
    has: true,
    when,
    date_long: longDay(sd),
    date_short: shortDay(sd),
    time,
    is_past: (ev.end || ev.start) < nowStamp,
    place_name: ev.place?.name ?? "",
    place_address: ev.place?.address ?? "",
    map_link: ev.place?.map_link ?? "",
    rsvp_label: ev.rsvp?.label || "",
    rsvp_link: ev.rsvp?.link || "",
    rsvp_deadline: ev.rsvp?.deadline ? `${t.rsvp_by} ${longDay(ev.rsvp.deadline)}` : "",
    schedule: (ev.schedule ?? []).map((s: Data) => ({ time: clock(s.time), title: s.title, note: s.note })),
    has_schedule: (ev.schedule ?? []).length > 0,
    status: ev.status === "cancelled" ? t.cancelled : ev.status === "changed" ? t.changed : "",
    is_cancelled: ev.status === "cancelled",
    is_changed: ev.status === "changed",
    start: ev.start,
  };
}

// --- palettes -------------------------------------------------------------------------

export const PALETTE_KEYS = ["bg", "ink", "muted", "accent", "accent-2", "line", "on-accent"] as const;

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

/** Problems with a theme's palettes: every colour named, and readable. */
export function paletteProblems(palettes: Data | undefined): string[] {
  if (palettes === undefined) return [];
  const out: string[] = [];
  if (!palettes || typeof palettes !== "object" || Array.isArray(palettes) || !Object.keys(palettes).length) return ["palettes: an object of {name: {title, colors}}"];
  for (const [name, p] of Object.entries(palettes)) {
    if (!/^[a-z][a-z0-9-]{0,29}$/.test(name)) out.push(`palette ${name}: names are lowercase-with-dashes`);
    if (!p?.title) out.push(`palette ${name}: needs a title`);
    const c = p?.colors ?? {};
    for (const k of PALETTE_KEYS) if (!/^#[0-9a-fA-F]{6}$/.test(String(c[k] ?? ""))) out.push(`palette ${name}: colors.${k} must be a #rrggbb colour`);
    if (out.some((x) => x.startsWith(`palette ${name}: colors.`))) continue;
    const need: [string, string, number][] = [["ink", "bg", 4.5], ["muted", "bg", 4.5], ["accent", "bg", 3], ["on-accent", "accent", 4.5]];
    for (const [fg, bg, min] of need) {
      const r = contrast(c[fg], c[bg]);
      if (r < min) out.push(`palette ${name}: ${fg} on ${bg} is ${r}:1, needs ${min}:1`);
    }
  }
  return out;
}

/** The palette's colours as CSS variables, appended after the theme's own stylesheet. */
export function paletteCss(palettes: Data | undefined, chosen: string): string {
  if (!palettes) return "";
  const p = palettes[chosen] ?? Object.values(palettes)[0];
  if (!p?.colors) return "";
  return `\n:root{${PALETTE_KEYS.map((k) => `--${k}:${p.colors[k]}`).join(";")}}\n`;
}
