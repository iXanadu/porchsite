/** Content kinds (SPEC §3). Unknown fields are refused, so typos fail loudly. */
import { z } from "zod";
import { STRINGS } from "./strings";

const line = (max: number) => z.string().trim().min(1).max(max);
const optLine = (max: number) => z.string().trim().max(max).default("");
const url = z
  .string()
  .trim()
  .max(500)
  .refine(
    (u) => /^https:\/\/[^\s]+$/.test(u) || /^\/[^\s]*$/.test(u) || /^#[a-z][a-z0-9-]{0,40}$/.test(u) || /^mailto:[^\s@]+@[^\s@]+$/.test(u) || /^tel:\+?[\d\s().-]{4,30}$/.test(u),
    "must be a full https:// link (e.g. https://example.com/page), a path on this site starting with / (e.g. /about), #name for a place on the same page, mailto:someone@example.com or tel:+12025550100",
  );
const optLink = z.union([z.literal(""), url]).default("");
const IMAGE =
  "an image: a full https:// link to a JPEG, PNG or WebP (up to 8 MB), copied into the site when you save, or a /media/... path this site gave you; empty for none";
const image = z
  .string()
  .trim()
  .max(500)
  .refine((u) => u === "" || /^https:\/\/[^\s]+$/.test(u) || /^\/media\/[^\s]+$/.test(u), "must be a full https:// link to the image, or a /media/... path from this site")
  .default("")
  .describe(IMAGE);
const alt = (of: string) => optLine(200).describe(`a few words saying what the ${of} shows, for people who can't see it; required when there is a ${of}`);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date written YYYY-MM-DD, e.g. 2026-10-08");


const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a 24-hour time written HH:MM, e.g. 09:00 or 17:30");
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const Contact = z
  .object({
    phone: optLine(30).describe("a phone number as people dial it, with its country code"),
    email: z.union([z.literal(""), z.string().trim().email().max(120)]).default("").describe("an email address shown on the site; empty for none"),
    address: z
      .object({ line1: optLine(120), line2: optLine(120), city: optLine(60), region: optLine(60), postcode: optLine(20), country: optLine(60) })
      .strict()
      .default({ line1: "", line2: "", city: "", region: "", postcode: "", country: "" })
      .describe("a street address, for places people visit; leave it empty for a home"),
    map_link: optLink.describe("a full https:// link to the place on a map (Google Maps, Apple Maps, OpenStreetMap); empty for none"),
    social: z.array(z.object({ kind: line(30), url }).strict()).max(8).default([]).describe("other places to find them: a list of {kind, url}, e.g. [{\"kind\": \"Instagram\", \"url\": \"https://instagram.com/...\"}]"),
  })
  .strict();

const Hours = z
  .object({
    weekly: z
      .array(
        z
          .object({ day: z.enum(WEEKDAYS), open: z.union([z.literal(""), hhmm]).default(""), close: z.union([z.literal(""), hhmm]).default(""), closed: z.boolean().default(false) })
          .strict(),
      )
      .max(14)
      .default([])
      .describe("opening hours by day: a list of {day: mon..sun, open: HH:MM, close: HH:MM} or {day, closed: true}; two rows for one day make split hours; a day not listed is shown closed"),
    exceptions: z
      .array(
        z
          .object({ from: day, to: z.union([z.literal(""), day]).default(""), label: optLine(60), open: z.union([z.literal(""), hhmm]).default(""), close: z.union([z.literal(""), hhmm]).default(""), closed: z.boolean().default(true) })
          .strict(),
      )
      .max(40)
      .default([])
      .describe("holidays and changes: a list of {from: YYYY-MM-DD, to (optional), label, closed: true} or with open/close and closed: false for different hours; shown for the next 60 days, then dropped by themselves"),
    note: optLine(200).describe("one line under the hours, e.g. Kitchen closes 30 minutes earlier"),
  })
  .strict();

export const SITE_ID = "site";

const streamId = z.string().regex(/^[a-z][a-z0-9-]{0,29}$/, "lowercase letters, digits or dashes, starting with a letter, e.g. writing");
// Section names, and top-level paths the site already uses (a stream's
// archive lives at /<id>/).
const RESERVED = ["cards", "notes", "about", "entries", "e", "media", "review", "setup", "upload", "mcp", "authorize", "oauth", "login", "logout", "static", "robots-txt", "collect"];
const Stream = z
  .object({
    id: streamId.refine((v) => !RESERVED.includes(v), `can't be one of: ${RESERVED.join(", ")}`).describe("short name entries use in their stream field, e.g. journal"),
    title: line(60).describe("the section's heading on the home page"),
    byline: optLine(160).describe("one line under the heading; empty for none"),
    layout: z
      .enum(["list", "cards", "feature"])
      .default("list")
      .describe("list (dated titles and summaries), cards (a grid with each entry's cover photo) or feature (the newest entry in full, with the notes; themes that have it)"),
    link_label: optLine(40).describe("for entries that live elsewhere (external_url): the text of the link out, e.g. Read on Substack; empty shows Read"),
    intro: optLine(600).describe("a paragraph introducing the stream, shown with it where the theme has room; empty for none"),
    author: optLine(60).describe("who writes this stream, shown on its entries where the theme has room, e.g. an assistant's name; empty for none"),
    nav_label: optLine(30).describe("its menu item; empty uses the title"),
    path: z
      .string()
      .regex(/^([a-z][a-z0-9-]{0,29})?$/, "lowercase letters, digits or dashes, e.g. reports")
      .refine((v) => !RESERVED.includes(v), `can't be one of: ${RESERVED.join(", ")}`)
      .default("")
      .describe("where its archive and entries live: /<path>/ and /<path>/<entry>/; empty uses the id"),
    anchor: optLine(30).describe("its section's id on the home page (the #name in links to it); empty uses the id"),
    description: optLine(300).describe("one or two sentences about the stream, for its archive's search results and link previews; {handle} becomes the X handle; empty uses the site's"),
    feed_subtitle: optLine(160).describe("the subtitle of its feed; {handle} becomes the X handle; empty uses the byline"),
    see_also_label: optLine(80).describe("on its archive, the words pointing to another stream (e.g. 'My own writing is'); empty uses that stream's name"),
    all_label: optLine(60).describe("text of the link to all its entries; empty uses 'All of <title>'"),
    dated_addresses: z
      .boolean()
      .default(true)
      .describe("true (the default): a new entry's address starts with its date, e.g. 2026-10-09-how-it-works; false: just its title words, e.g. how-it-works, for pages people come back to. Entries already made keep theirs"),
  })
  .strict();

const DATE = "the owner's local date, written YYYY-MM-DD, e.g. 2026-10-08";
const LINK = "a full https:// link (e.g. https://example.com/page), a path on this site starting with / (e.g. /about), #name for a place on the same page, mailto:someone@example.com, or tel:+12025550100";

/** Every word on the site that isn't an entry, card or note. */
export const SiteData = z
  .object({
    title: line(80).default("My site").describe("site name, shown top left and in the browser tab"),
    tagline: optLine(160).describe("the big headline on the home page"),
    description: optLine(300).describe("one or two sentences about the site, for search results and link previews; empty uses the tagline"),
    intro: z.string().trim().max(1200).default("").describe("one paragraph under the headline"),
    about: z.string().trim().max(8000).default("").describe("the About section, Markdown"),
    owner_name: optLine(80).describe("the owner's name, shown in the footer"),
    links: z
      .array(z.object({ label: line(40), url }).strict())
      .max(8)
      .default([])
      .describe("menu links top right: a list of {label, url}"),
    hero: image,
    hero_alt: alt("hero image"),
    logo: image.describe(`the site's mark, a small square picture shown beside its name where the theme has room, and the browser tab's icon; ${IMAGE}`),
    logo_alt: alt("mark"),
    follow_image: image.describe(`a small round photo of the owner beside the Follow link, where the theme shows one; empty for none; ${IMAGE}`),
    follow_image_alt: alt("photo"),
    share_image: image.describe(`the picture shown when a link to the site is shared (X, messages): 1200x630 works everywhere; empty uses the hero image; ${IMAGE}`),
    share_image_alt: alt("share picture"),
    palette: z
      .string()
      .regex(/^([a-z][a-z0-9-]{0,29})?$/)
      .default("")
      .describe("the colours: one of the theme's palettes by name (theme_needs lists them); empty uses the theme's first"),
    contact: Contact.default({ phone: "", email: "", address: { line1: "", line2: "", city: "", region: "", postcode: "", country: "" }, map_link: "", social: [] }).describe("how to reach or find them, where the theme shows it: {phone, email, address: {line1, line2, city, region, postcode, country}, map_link, social: [{kind, url}]}"),
    hours: Hours.default({ weekly: [], exceptions: [], note: "" }).describe("opening hours, where the theme shows them, in the site's timezone: {weekly, exceptions, note}"),
    notice: z
      .object({ text: optLine(200), until: z.union([z.literal(""), day]).default("") })
      .strict()
      .default({ text: "", until: "" })
      .describe("a banner across the top for news that can't wait, e.g. Closed today for a burst pipe: {text, until: YYYY-MM-DD}; it disappears by itself after until; empty text for none"),
    buttons: z
      .array(z.object({ label: line(60), url, note: optLine(120) }).strict())
      .max(24)
      .default([])
      .describe("a list of big link buttons, where the theme has one (a link page): [{label, url, note}]"),
    hero_caption: optLine(200).describe("a line under the hero image where the theme shows one; empty for none"),
    theme: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .default("built-in")
      .describe("the site's look: built-in, or a theme this site has (personal-homepage, product-page, or one installed from the catalog)"),
    handle: z
      .string()
      .regex(/^([A-Za-z0-9_]{1,15})?$/, "an X handle without the @, e.g. your_handle")
      .default("")
      .describe("the owner's X handle without the @, for themes with a Follow button; empty for none"),
    follow_label: optLine(40).describe("text of the Follow button where the theme has one; empty shows 'Follow on X'"),
    logo_text: optLine(40).describe("short name top left where the theme shows one; empty uses the title"),
    footer_line: optLine(120).describe("a line in the footer where the theme has one"),
    contact_line: optLine(80).describe("how to reach the owner, in the footer where the theme has one, e.g. DM me on X"),
    cta_label: optLine(60).describe("a hero button's text where the theme has one; empty hides it"),
    cta_link: optLink.describe(`where that hero button goes: ${LINK}`),
    timezone: z
      .string()
      .trim()
      .max(60)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "an IANA time zone, e.g. America/New_York")
      .default("UTC")
      .describe("the owner's time zone for times the site shows, e.g. America/New_York; default UTC"),
    cards_aside: optLine(30).describe("a card group shown after the others under its own heading, each card a whole link (e.g. Open source); empty for none"),
    cta2_label: optLine(60).describe("a second hero button's text, where the theme has one; empty hides it"),
    cta2_link: optLink.describe(`where the second hero button goes, e.g. /#writing: ${LINK}`),
    streams: z
      .array(Stream)
      .min(1)
      .max(8)
      .default([{ id: "journal", title: "Updates", byline: "", layout: "list", link_label: "", intro: "", author: "", nav_label: "", path: "", anchor: "", description: "", feed_subtitle: "", see_also_label: "", all_label: "", dated_addresses: true }])
      .refine((v) => new Set(v.map((x) => x.id)).size === v.length, "each stream id at most once")
      .describe("the kinds of entries the site has, each its own home section: a list of {id, title, byline, layout, link_label, dated_addresses}. The first is where an entry goes when it names no stream"),
    cards_title: line(60).default("Projects").describe("heading of the cards section"),
    cards_nav: optLine(30).describe("the cards section's menu item; empty uses its heading"),
    cards_anchor: optLine(30).describe("the cards section's id on the home page; empty uses cards"),
    notes_title: line(60).default("Lately").describe("heading of the notes section"),
    about_title: line(60).default("About").describe("heading of the About section"),
    sections: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,29}$/, "a stream id, or cards, notes, about"))
      .max(12)
      .default(["entries", "cards", "notes", "about"])
      .refine((v) => new Set(v).size === v.length, "each section at most once")
      .describe("home page sections in order: stream ids, cards, notes, about; entries means every stream not listed by id. Leave one out to hide it. A section with nothing published (or an empty About) is hidden anyway"),
    card_groups: z
      .array(
        z
          .object({
            name: line(60),
            style: z.enum(["", "list", "faq", "steps", "reviews"]).default(""),
          })
          .strict(),
      )
      .max(24)
      .default([])
      .refine((v) => new Set(v.map((x) => x.name)).size === v.length, "each group name at most once")
      .describe("what kind each card group is, for looks that show kinds differently: [{name, style}], name as in the cards' group; style is faq (each card a question, its description the answer), steps (numbered, in sort order), reviews (each description a quote, the card's name who said it), list (plain rows) or empty (the look's usual cards)"),
    strings: z
      .object(Object.fromEntries(Object.keys(STRINGS).map((k) => [k, z.string().trim().max(120).optional()])))
      .strict()
      .default({})
      .describe(`the look's own words, to change any of them (e.g. another language): {name: words}; empty keeps the default. Names and defaults: ${Object.entries(STRINGS).map(([k, v]) => `${k} "${v}"`).join(", ")}`),
  })
  .strict();

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export const EntryData = z
  .object({
    stream: optLine(30).describe("id of the stream it belongs to (see the site's streams); empty means the first stream"),
    title: line(160).describe("the post's title"),
    date: day.describe(DATE),
    summary: z.string().trim().max(600).default("").describe("one or two sentences shown in lists"),
    body: z
      .string()
      .max(60000)
      .default("")
      .describe("the post itself, Markdown. Images: ![what it shows](https://...) on a line of its own; each is copied into the site when you save"),
    cover: image,
    cover_alt: alt("cover image"),
    external_url: optLink.describe("the full https:// address when the post lives elsewhere (an article on another site): the site lists it and links there instead of giving it a page; empty for a post on this site"),
    stats: z
      .array(z.object({ value: line(20), label: line(40) }).strict())
      .max(6)
      .default([])
      .describe("optional number tiles shown on the entry's page: a list of {value, label}, e.g. [{\"value\": \"12\", \"label\": \"commits\"}]"),
    tags: z
      .array(z.string().regex(/^[a-z0-9-]{1,30}$/, "lowercase words or-dashes, e.g. garden"))
      .max(10)
      .default([])
      .describe("list of lowercase words, e.g. [\"garden\", \"recipes\"]"),
    event: z
      .object({
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, "a local date and time written YYYY-MM-DDTHH:MM, e.g. 2026-06-13T18:00"),
        end: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/)]).default(""),
        place: z.object({ name: optLine(120), address: optLine(200), map_link: optLink }).strict().default({ name: "", address: "", map_link: "" }),
        rsvp: z.object({ label: optLine(40), link: optLink, deadline: z.union([z.literal(""), day]).default("") }).strict().default({ label: "", link: "", deadline: "" }),
        schedule: z.array(z.object({ time: hhmm, title: line(120), note: optLine(200) }).strict()).max(30).default([]),
        status: z.enum(["on", "changed", "cancelled"]).default("on"),
      })
      .strict()
      .nullable()
      .default(null)
      .describe("makes the entry an event, for themes that show events (times in the site's timezone): {start: YYYY-MM-DDTHH:MM, end, place: {name, address, map_link}, rsvp: {label, link, deadline}, schedule: [{time: HH:MM, title, note}], status: on|changed|cancelled}; null for an ordinary entry"),
    status: z
      .enum(["draft", "ready"])
      .default("ready")
      .describe("ready (can be published once approved) or draft (never shown; can't be sent for approval)"),
    slug: z
      .string()
      .regex(SLUG, "lowercase letters, digits and dashes (not first or last), at most 80, e.g. how-it-works")
      .optional()
      .describe("optional: the last part of the entry's page address, /<stream path>/<slug>/, e.g. how-it-works; unset, it is made once from the date and title (the title alone in a stream with dated_addresses false). Changing it moves the page, and the old address sends visitors to the new one"),
  })
  .strict();

export const CardData = z
  .object({
    name: line(80).describe("the card's title, e.g. a project or service name"),
    description: z.string().trim().min(1).max(600).describe("a sentence or two"),
    link: optLink.describe(`${LINK}; empty for none`),
    link_label: optLine(40).describe("text for the link; the link itself is shown if empty"),
    image: image,
    image_alt: alt("image"),
    badge_tone: z.enum(["live", "building"]).default("building").describe("the badge's colour where the theme has two: live (green) or building (tan)"),
    badge: optLine(30).describe("short text shown exactly as written in a badge on the card, e.g. Live, Beta, Paused; display only, it doesn't affect publishing; empty shows none"),
    group: optLine(30).describe("optional label for grouping cards (a menu section, Experience, FAQ); the built-in look doesn't show it"),
    subtitle: optLine(120).describe("a line under the name where the theme shows one: a role, an employer, a dish's style; empty for none"),
    period: optLine(40).describe("a time span where the theme shows one, e.g. 2019 – 2023; empty for none"),
    price: optLine(30).describe("a price shown exactly as written, e.g. $18, From $40, Market price; empty for none"),
    tags: z.array(optLine(20)).max(8).default([]).describe("short labels shown on the card, e.g. [\"V\", \"GF\"]; empty for none"),
    sort: z.number().int().min(0).max(10000).default(100).describe("order in the grid: lower comes first; default 100; ties sort by name"),
    visibility: z
      .enum(["public", "mention", "private"])
      .default("public")
      .describe("who sees it: public (the whole card), mention (its name and description only: no link, no picture; an entry may name it once in its summary and once in its body) or private (never shown; its name may not appear anywhere public, so the site refuses content that names it)"),
  })
  .strict();

export const NoteData = z
  .object({
    text: line(240).describe("one line, e.g. what happened this week"),
    date: day.describe(DATE),
    link: optLink.describe(`${LINK}; empty for none`),
  })
  .strict();

export const MODELS = { site: SiteData, entry: EntryData, card: CardData, note: NoteData } as const;
export type Kind = keyof typeof MODELS;
export const KINDS = Object.keys(MODELS) as Kind[];
export const PREFIX: Record<Kind, string> = { site: "site", entry: "ent", card: "crd", note: "nte" };

/** Every kind's fields in plain words, from the schemas so it can't drift. */
export function fieldGuide(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const k of KINDS) {
    const shape = MODELS[k].shape as Record<string, z.ZodType>;
    out[k] = {};
    for (const [name, t] of Object.entries(shape)) {
      const required = !t.safeParse(undefined).success;
      out[k][name] = `${required ? "required. " : ""}${t.description ?? ""}`.trim();
    }
  }
  return out;
}

export const KIND_GUIDE = {
  site: "the site's standing text and layout. Exactly one, id \"site\"; create it once if site_state doesn't list it, then change it with item_update",
  entry: "a dated post in one of the site's streams (its home section): with its own page (body in Markdown), or, with external_url, a listing that links to where it lives",
  card: "a tile in the cards grid: projects, services, products. The grid's heading is the site's cards_title",
  note: "a short dated line in the notes list (heading: the site's notes_title)",
};
