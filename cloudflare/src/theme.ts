/**
 * Mustache themes (spec/TEMPLATES.md). A theme is a folder of
 * logic-less templates; everything it shows is decided here, display-ready:
 * dates formatted, links resolved, flags set. Home sections are entries (one
 * per stream), cards, or about; each entries section, entry page and archive
 * carries its stream, so a theme names no stream and holds no words of its own
 * beyond its UI strings.
 */
import { bodyMarkdown, finishEmbeds, headingBodies } from "./embeds";
import Mustache from "mustache";
import { THEMES } from "./themes.gen";
import { dateString } from "./date-format";
import { markdown } from "./html";
import type { SiteView } from "./site";
import { contactView, eventView, hoursView, noticeView, paletteCss } from "./blocks";
import { stringsOf } from "./strings";
import type { Theme } from "./themes";
import { BEACON_JS } from "./beacon";

type Data = Record<string, any>;


const day = (d: string) => new Date(`${d}T12:00:00Z`);
const shortDate = (d: string) => dateString(day(d), { month: "short", day: "numeric" });
const longDate = (d: string) => dateString(day(d), { month: "long", day: "numeric", year: "numeric" });
const host = (u: string) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
};

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The site's streams as a theme sees them. */
export function streams(site: Data): Data[] {
  const all = site.streams as Data[];
  return all.map((s, i) => {
    const other = all.find((_, j) => j !== i);
    const path = s.path || s.id;
    return {
      id: s.id,
      anchor: s.anchor || s.id,
      title: s.title,
      byline: s.byline,
      intro: s.intro,
      author: s.author,
      nav_label: s.nav_label || s.title,
      archive_url: `/${path}/`,
      feed_url: `/${path}/feed.xml`,
      path,
      all_label: s.all_label || `${stringsOf(site).all_of} ${s.title}`,
      link_label: s.link_label,
      description: String(s.description ?? "").replace("{handle}", site.handle ?? ""),
      feed_subtitle: String(s.feed_subtitle ?? "").replace("{handle}", site.handle ?? ""),
      see_also: other ? { label: s.see_also_label || other.nav_label || other.title, url: `/${other.path || other.id}/` } : null,
      is_feature: s.layout === "feature",
      is_list: s.layout !== "feature",
    };
  });
}

type Ctx = { tz: string; now: Date; strings?: Record<string, string> };
const ctxOf = (v: SiteView): Ctx => ({ tz: String(v.site.timezone || "UTC"), now: v.now ?? new Date(), strings: stringsOf(v.site) });

function entry(e: Data, stream: Data, anchor = "", ctx: Ctx = { tz: "UTC", now: new Date() }): Data {
  const tags = (e.tags ?? []) as string[];
  return {
    ...e,
    event: eventView(e.event, ctx.tz, ctx.now, ctx.strings),
    url: e.url,
    anchor,
    date_short: shortDate(e.date),
    date_long: longDate(e.date),
    has_body: !!e.body && !e.external_url,
    body_html: e.body && !e.external_url ? bodyMarkdown(e.body) : "",
    stats: e.stats ?? [],
    has_stats: !!(e.stats ?? []).length,
    external: !!e.external_url,
    cover_src: e.cover || "",
    cover_alt: e.cover_alt || "",
    tags: tags.map((name) => ({ name })),
    has_tags: tags.length > 0,
    label: e.external_url ? stream.link_label || "Read" : "",
    link: "",
    link_host: "",
  };
}

function card(c: Data, aside = false): Data {
  return {
    name: c.name,
    description: c.description,
    status: c.badge ?? "",
    status_tone: c.badge_tone ?? "building",
    link: c.link,
    link_text: c.link_label || (c.link ? host(c.link) : ""),
    as_link: aside && !!c.link,
    group: slug(c.group ?? ""),
    group_label: c.group ?? "",
    subtitle: c.subtitle ?? "",
    period: c.period ?? "",
    price: c.price ?? "",
    tags: ((c.tags ?? []) as string[]).filter(Boolean).map((name) => ({ name })),
    has_tags: ((c.tags ?? []) as string[]).some(Boolean),
    image_src: c.image ?? "",
    image_alt: c.image_alt ?? "",
    has_image: !!c.image,
  };
}

function siteWords(v: SiteView, release: string, origin: string): Data {
  const s = v.site;
  return {
    ...s,
    site_name: s.title,
    logo_text: s.logo_text || s.title,
    handle: s.handle,
    x_url: s.handle ? `https://x.com/${s.handle}` : "",
    follow_label: s.follow_label || "Follow on X",
    description: s.description || s.tagline || s.intro.slice(0, 160),
    hero_image: s.hero,
    contact: contactView(s.contact),
    hours: hoursView(s.hours, String(s.timezone || "UTC"), v.now ?? new Date(), stringsOf(s)),
    notice: noticeView(s.notice, String(s.timezone || "UTC"), v.now ?? new Date()),
    buttons: s.buttons ?? [],
    has_buttons: (s.buttons ?? []).length > 0,
    hero_width: v.hero_size[0] || 1200,
    hero_height: v.hero_size[1] || 800,
    contact_email: "",
    updated: v.updated,
    release,
    base_url: origin,
  };
}

function base(v: SiteView, release: string, origin: string, meta: { kind: string; content_id?: string; title: string; description?: string; path?: string; og_type?: string; image?: string }): Data {
  const site = siteWords(v, release, origin);
  const st = streams(v.site);
  const named: Record<string, string> = { cards: v.site.cards_nav || v.site.cards_title, notes: v.site.notes_title, about: v.site.about_title };
  const anchorOf = (k: string) => (k === "cards" ? v.site.cards_anchor || "cards" : k);
  const sections: string[] = (v.site.sections as string[]).flatMap((k) =>
    k === "entries" ? st.filter((x) => !(v.site.sections as string[]).includes(x.id)).map((x) => x.id) : [k],
  );
  return {
    site,
    highlights: v.cards.map(c => card(c)),
    has_highlights: v.cards.length > 0,
    page: {
      lede: v.site.intro,
      hero_alt: v.site.hero_alt,
      hero_caption: v.site.hero_caption,
      cta_label: v.site.cta_label,
      cta_link: v.site.cta_link,
      writing_cta_label: "",
    },
    strings: stringsOf(v.site),
    // The menu names only sections with something in them: a stream with no
    // entries, no cards or an empty About would lead nowhere.
    nav: sections
      .filter((k) => k !== "notes")
      .filter((k) => (k === "cards" ? v.cards.length > 0 : k === "about" ? !!String(v.site.about ?? "").trim() : v.entries.some((e) => e.stream === k)))
      .map((k) => {
        const s = st.find((x) => x.id === k);
        return { href: `/#${s ? s.anchor : anchorOf(k)}`, label: s ? s.nav_label : named[k] ?? k };
      }),
    feeds: st.map((x) => ({ title: x.nav_label, url: x.feed_url })),
    kit: {
      css_url: `/static/site.css?v=${release}`,
      beacon_url: `/static/a.js?v=${release}`,
      filter_url: `/static/filter.js?v=${release}`,
      search_url: `/static/search.js?v=${release}`,
    },
    meta: {
      title: meta.title,
      description: meta.description ?? site.description,
      og_type: meta.og_type ?? "website",
      url: `${origin}${meta.path ?? "/"}`,
      image: meta.image ? `${origin}${meta.image}` : v.site.share_image ? `${origin}${v.site.share_image}` : s(v) ? `${origin}${v.site.hero}` : "",
      image_alt: meta.image ? "" : v.site.share_image ? v.site.share_image_alt : s(v) ? v.site.hero_alt : "",
      kind: meta.kind,
      content_id: meta.content_id ?? "",
    },
  };
}
const s = (v: SiteView) => !!v.site.hero;

/** A card group's style (the site's card_groups) and a flag per style, for logic-less templates. */
function groupStyle(site: Data, name: string): Data {
  const style = String(((site.card_groups ?? []) as Data[]).find((x) => x.name === name)?.style ?? "");
  return { style, is_faq: style === "faq", is_steps: style === "steps", is_reviews: style === "reviews", is_list: style === "list" };
}

export function homeView(v: SiteView, release: string, origin: string): Data {
  const st = streams(v.site);
  const order: string[] = v.site.sections;
  const keys = order.flatMap((k) => (k === "entries" ? st.filter((x) => !order.includes(x.id)).map((x) => x.id) : [k]));
  const out: Data[] = [];
  for (const k of keys) {
    const stream = st.find((x) => x.id === k);
    const sec: Data = { is_entries: !!stream, is_cards: k === "cards", is_about: k === "about" };
    if (stream) {
      const items = v.entries.filter((e) => e.stream === stream.id);
      sec.stream = stream;
      sec.show = items.length > 0;
      sec.latest = items.length ? [entry(items[0], stream, "", ctxOf(v))] : [];
      sec.more_than_one = items.length > 1;
      sec.activity = v.notes.map((n) => ({ ...n, date_short: shortDate(n.date) }));
      sec.has_activity = stream.is_feature && v.notes.length > 0;
      sec.items = items.slice(0, 3).map((e, i) => entry(e, stream, i === 0 ? "article" : "", ctxOf(v)));
      // Events: the next ones first, soonest first; past ones after, newest first.
      const evs = items.filter((e) => e.event).map((e) => entry(e, stream, "", ctxOf(v)));
      sec.upcoming = evs.filter((e) => !e.event.is_past).sort((a, b) => String(a.event.start).localeCompare(String(b.event.start)));
      sec.earlier = evs.filter((e) => e.event.is_past).sort((a, b) => String(b.event.start).localeCompare(String(a.event.start)));
      sec.has_upcoming = sec.upcoming.length > 0;
      sec.has_earlier = sec.earlier.length > 0;
      // Entries that aren't events, in a stream that has some: newest first.
      sec.others = evs.length ? items.filter((e) => !e.event).map((e) => entry(e, stream, "", ctxOf(v))) : [];
      sec.has_others = sec.others.length > 0;
      sec.all = items.map((e) => entry(e, stream, "", ctxOf(v)));
      sec.count_suffix = items.length > 3 ? ` (${items.length})` : "";
    } else if (k === "cards") {
      const groups = [...new Set(v.cards.map((c) => c.group).filter(Boolean))];
      // The aside group goes last, under its own heading, each card a link.
      const asideName = String(v.site.cards_aside || "");
      const main = v.cards.filter((c) => !asideName || c.group !== asideName);
      const aside = asideName ? v.cards.filter((c) => c.group === asideName) : [];
      const order = [...groups.filter((g) => g !== asideName), ...groups.filter((g) => g === asideName)];
      Object.assign(sec, {
        anchor: v.site.cards_anchor || "cards",
        title: v.site.cards_title,
        show: v.cards.length > 0,
        groups: order.map((g) => ({ key: slug(g), label: g, count: v.cards.filter((c) => c.group === g).length })),
        has_chips: groups.length > 1,
        projects: main.map((c) => card(c)),
        has_projects: main.length > 0,
        open_source: aside.map((c) => card(c, true)),
        has_open_source: aside.length > 0,
        open_source_label: asideName,
        by_group: order.length
          ? [...(main.some((c) => !c.group) ? [""] : []), ...order.filter((g) => g !== asideName)].map((g) => ({
              label: g,
              key: slug(g),
              cards: main.filter((c) => (c.group ?? "") === g).map((c) => card(c)),
              ...groupStyle(v.site, g),
            }))
          : [{ label: "", key: "", cards: main.map((c) => card(c)), ...groupStyle(v.site, "") }],
      });
    } else if (k === "about") {
      Object.assign(sec, {
        anchor: "about",
        title: v.site.about_title,
        paragraphs: String(v.site.about)
          .split(/\n\s*\n/)
          .map((p) => p.trim())
          .filter(Boolean),
      });
    }
    out.push(sec);
  }
  out.forEach((sec, i) => (sec.not_last = i < out.length - 1));
  return {
    ...base(v, release, origin, { kind: "home", title: v.site.tagline ? `${v.site.title}: ${v.site.tagline}` : v.site.title }),
    // The theme's hero buttons show with a button to show.
    has_writing: !!v.site.cta_label,
    hero_more: v.site.cta2_label ? { href: v.site.cta2_link || "/", label: v.site.cta2_label } : null,
    sections: out,
  };
}

export function entryView(v: SiteView, e: Data, release: string, origin: string): Data {
  const stream = streams(v.site).find((x) => x.id === e.stream)!;
  return {
    ...base(v, release, origin, { kind: "entry", content_id: e.id, title: `${e.title} · ${v.site.title}`, description: e.summary || e.title, path: e.url, og_type: "article", image: v.share_cards?.[e.id] || e.cover || undefined }),
    entry: entry(e, stream, "", ctxOf(v)),
    stream,
    // Where to go next from this page: the site's main button, or the second
    // one when the main button points here.
    next: (() => {
      const here = (l: string) => l === e.page || l === e.url;
      if (v.site.cta_label && v.site.cta_link && !here(v.site.cta_link)) return { href: v.site.cta_link, label: v.site.cta_label };
      if (v.site.cta2_label && v.site.cta2_link && !here(v.site.cta2_link)) return { href: v.site.cta2_link, label: v.site.cta2_label };
      return null;
    })(),
  };
}

export function archiveView(v: SiteView, streamPath: string, release: string, origin: string, tag?: string): Data | null {
  const stream = streams(v.site).find((x) => x.path === streamPath);
  if (!stream) return null;
  let items = v.entries.filter((e) => e.stream === stream.id);
  const counts = new Map<string, number>();
  for (const e of items) for (const t of e.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  if (tag) items = items.filter((e) => (e.tags ?? []).includes(tag));
  const path = tag ? `${stream.archive_url}tags/${tag}/` : stream.archive_url;
  return {
    // Shared, the page shows its newest entry's cover, as an entry's page shows its own.
    ...base(v, release, origin, { kind: tag ? "tag" : "archive", title: `${tag ? `#${tag} · ` : ""}${stream.nav_label} · ${v.site.title}`, path, description: stream.description || undefined, image: items.find((e) => e.cover)?.cover || undefined }),
    stream,
    tag: tag ?? "",
    entries: items.map((e) => entry(e, stream, "", ctxOf(v))),
    tags: [...counts].sort().map(([name, count]) => ({ name, count })),
    has_tags: counts.size > 0,
  };
}

export function notFoundView(v: SiteView, release: string, origin: string): Data {
  return base(v, release, origin, { kind: "notfound", title: `${stringsOf(v.site).not_found_title} · ${v.site.title}` });
}

// The same escaping as the Python edition (markupsafe), so a theme renders
// the same bytes on both: & < > " ' and nothing else.
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" };
Mustache.escape = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);

// The built-in registry is static: parsing its templates belongs to startup,
// while installed looks keep Mustache's normal cache on first use.
for (const theme of Object.values(THEMES)) {
  for (const template of [...Object.values(theme.pages), ...Object.values(theme.partials)]) Mustache.parse(template);
}

export function render(t: Theme, page: string, view: Data, policy?: { sources: unknown; origin: string }): string {
  if (t.manifest?.heading_ids === true || t.manifest?.body_h1_as_h2 === true) view = headingBodies(view, t.manifest.heading_ids === true, t.manifest.body_h1_as_h2 === true);
  return finishEmbeds(Mustache.render(t.pages[page], view, t.partials), policy?.sources, policy?.origin, view);
}

const STATIC_TYPES: Record<string, string> = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8" };

const xml = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** A stream's Atom feed: its newest 20 entries (feeds belong to the site, not the theme). */
export function feed(v: SiteView, streamPath: string, origin: string): Response | null {
  const stream = streams(v.site).find((x) => x.path === streamPath);
  if (!stream) return null;
  const items = v.entries.filter((e) => e.stream === stream.id).slice(0, 20);
  const updated = items.length ? `${items[0].date}T12:00:00Z` : new Date(0).toISOString();
  const handle = v.site.handle ? `@${v.site.handle}` : "";
  // An assistant's stream is "<assistant> for @owner"; the owner's own is "@owner".
  const author = stream.author ? (handle ? `${stream.author} for ${handle}` : stream.author) : handle || v.site.owner_name || v.site.title;
  const subtitle = stream.feed_subtitle
    ? stream.author && stream.byline
      ? `${stream.feed_subtitle}, ${stream.byline}.`
      : stream.feed_subtitle
    : stream.byline;
  const body = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${xml(stream.nav_label)} · ${xml(v.site.title)}</title>
${subtitle ? `<subtitle>${xml(subtitle)}</subtitle>\n` : ""}<link href="${origin}${stream.feed_url}" rel="self"/>
<link href="${origin}${stream.archive_url}"/>
<id>${origin}${stream.archive_url}</id>
<updated>${updated}</updated>
<author><name>${xml(author)}</name></author>
${items
  .map((e) => {
    const url = e.external_url || `${origin}${e.url}`;
    return `<entry>
<title>${xml(e.title)}</title>
<link href="${xml(url)}"/>
<id>${xml(url)}</id>
<updated>${e.date}T12:00:00Z</updated>
<summary>${xml(e.summary)}</summary>
</entry>
`;
  })
  .join("")}</feed>
`;
  return new Response(body, { headers: { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}

/** What a stream's search box filters in the browser (the classic format). */
export function searchIndex(v: SiteView, streamPath: string): Response | null {
  const stream = streams(v.site).find((x) => x.path === streamPath);
  if (!stream) return null;
  const rows = v.entries
    .filter((e) => e.stream === stream.id)
    .map((e) => ({
      t: e.title,
      s: e.summary,
      g: e.tags ?? [],
      u: e.url,
      d: shortDate(e.date),
      l: e.external_url ? stream.link_label || "Read" : "",
      x: !!e.external_url,
      b: String(e.body ?? "").replace(/[#*_`>\[\]()!-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000),
    }));
  return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" } });
}

/** A theme's own files (CSS, scripts), served at /static/<file>. */
export function staticFile(t: Theme, file: string, palette = ""): Response | null {
  // The beacon is the kit's, never a theme's own.
  const own = file === "a.js" ? BEACON_JS : t?.static[file];
  // The site's palette goes after the theme's stylesheet, so its colours win.
  const body = own !== undefined && file === "site.css" ? own + paletteCss(t.manifest.palettes, palette) : own;
  if (body === undefined) return null;
  return new Response(body, {
    headers: {
      "Content-Type": STATIC_TYPES[file.split(".").pop() ?? ""] ?? "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
