# Porchsite templates (draft 1)

A template is the look of a Porchsite site and nothing else. The same
template renders the same bytes in every edition, because every edition hands
it the same data (the **view**, below), renders it with Mustache, and escapes
the same way (`& < > " '` only).

Draft 1 describes what both editions render today; every look in `themes/`
ships with both.

## 1. What a template is

A folder:

```
my-template/
├── template.json        # manifest (required)
├── home.mustache        # the home page (required)
├── entry.mustache       # one entry's own page (required)
├── archive.mustache     # a stream's entries, in its chosen order (required)
├── tag.mustache         # a stream's entries with one tag (required)
├── not_found.mustache   # the 404 page (required)
├── partials/            # optional *.mustache, used as {{> name}}
├── sample-media/        # optional example photos for local/catalog previews only
└── static/              # site.css (required) and the template's scripts,
                         # served at /static/<file>
```

`sample-media/` may hold licensed example JPEG/PNG/WebP files named like the
sample's `/media/<32-hex>.<ext>` paths, with source/license notes. The kit's
local/catalog preview copies them into its preview folder. They are never
installed as site media, included in the Worker registry or theme package,
or published by choosing a look; real sites upload their own photographs.
Raw parity output retains the ordinary `/media/` paths.

`template.json`:

```json
{
  "name": "harbor",
  "title": "Harbor",
  "author_x": "harbor_maker",
  "licence": "MIT",
  "version": "1.0.0",
  "sections": ["entries", "cards", "about"],
  "layouts": ["feature", "list"],
  "previews": []
}
```

`author_x` (optional): the maker's X handle, without the @ (X's rule: 1
to 15 letters, digits or underscores). It's a claim, not credit: a look is
credited only once the claim is verified (§3c). Credit is an X handle and
nothing else: a manifest with any other author field (a name, an email, a
link: `author`, `author_name`, `email`, `url`, `homepage`, …) fails the
checks.

`type`: what kind of site it's for (`personal`, `product`, …); the
catalog groups themes by it, and an assistant asks its person what the site
is for before showing themes; name a template for its use (`product-page`,
`personal-homepage`), not for its look. `art`: the brief a designer would
give for the template's pictures: `ask` (what to settle with the person,
e.g. one subject that stands for the site), `style`, `prompt_prefix`, and
`steps` including the checks to run before using any picture; slot prompts
may use `{subject}`. `slots`: what the template needs from
the site, so an assistant can gather it before switching:

- `images`: `[{field, alt, size: [w, h], need, purpose, alt_hint, prompt}]`.
  `field` is `site.<name>`, `entry.cover`, `card.image` or `body` (an image in Markdown);
  `size` sets the shape and the minimum; `need` is `required`,
  `recommended` or `optional`; `prompt` is a starting point for making one.
- `content`: `[{field, need, purpose}]`, the words and settings the
  template reads and what it does with each.

`heading_ids` (optional boolean, default `false`): opt in to stable ids on
headings in entry Markdown bodies, on home, entry and archive/tag views.
The same heading has the same id wherever that body is shown. Derive ids
from the rendered heading's visible text: lowercase ASCII A-Z only, keep
`[a-z0-9]`, replace every run of anything else (including all non-ASCII)
with one `-`, and trim `-`. Cut the base to 64 characters and trim `-`
again; an empty base becomes `section`. There is no Unicode normalization:
for example, `Café` becomes `caf`. This is identical on every runtime.
Repeats in one body add `-2`, `-3`, and so on; collisions with an already
used id also advance that suffix. A per-base next-suffix map keeps repeated
allocation linear in the number of headings, including pre-existing suffixes.
Fenced/indented code and inline code keep their ordinary Markdown behavior.
The flag changes no stored content, and omitted/false keeps all existing
look output byte-identical. Menus and hero buttons can already use local
paths with fragments such as `/listing/home/#video-tour`; no new URL form
is needed. Theme-authored element ids remain the look's responsibility.

`body_h1_as_h2` (optional boolean, default `false`) renders entry-body
Markdown level-one headings as `<h2>`; all other levels and heading-id
text stay unchanged. Only the Listing look enables this flag, so each of
its pages has one look-authored `<h1>` even when a body contains `# Photos`.
Both flags are manifest-scoped and do not change stored Markdown.

The built-in `listing-page` look is for one property. It uses a wide real
property photo, price/stat figures, entry-body photos as a responsive
gallery, in-place video/tour embeds, open-house information, contact and a
map link. Its `art` brief asks for the property's actual photos, never
invented rooms, engravings or mascot art. `theme_needs` returns that look's
own manifest art brief and image purposes, including for built-in looks.

`sections`: the home section kinds the template draws. `layouts`: the stream
layouts it draws (a stream set to a layout the template lacks is drawn as
`list`).

### Private-site access precedes templates

A look never grants or restricts access. Both editions apply the private-site
gate (SPEC §3) before constructing a template view, resolving a redirect or
looking up media. Visitors get the exact blank noindex 404 rather than the
look's home or not_found page. Readers see published views only and receive
no owner controls or preview data. Every gated private response, including
signed-in pages and static/media responses on gated paths, is private,
no-store, no-transform; conditional requests still check access. A private site's anonymous
robots answer disallows all crawling, and its sitemap is the same blank.
No script, template or theme choice substitutes for the access gate.

## 2. The rules

- **Mustache only:** variables, sections, inverted sections, partials.
  No lambdas, no delimiter changes. A value the view doesn't have is an
  error in the Python edition, so templates may use only what's listed here.
- **Triple braces only for `*_html`.** `{{{body_html}}}` is allowed because
  the edition produced that HTML itself (rendered Markdown, safe; the
  dialect is in SPEC.md §3). It can hold `<h1>` to `<h6>`, `<p>`, `<br>`,
  `<ul>`/`<ol>` (nested; `<ol start>`), `<blockquote>`, `<hr>`,
  `<pre><code>`, `<code>`, `<em>`, `<strong>`, `<a>`, `<img>`, and pipe
  tables (`<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th scope="col">`, `<td>`,
  with optional fixed `align`), so a look
  styles all of them. Pipe tables have an engine-owned `.md-table` wrapper
  with horizontal scrolling and `tabindex="0"`, plus fixed table spacing;
  looks may add table styling but must retain narrow-screen usability.
- **Scripts only from the kit or `static/`,** by `<script src>`, never
  inline. Pages are served with a Content-Security-Policy that blocks the
  rest.
- **No outside requests** except Google Fonts. No trackers, no remote images.
- **No fixed words.** Visible text comes from the view: `site.*`, `page.*`,
  a stream, content, or `strings.*`.
- **No stream names.** A template never writes `journal`, `writing` or any
  other stream id or address; it reads them from the stream it is given.
- **Works small:** usable at 320 px wide; text contrast at least 4.5:1;
  every `<img>` gets `alt` from the view.

### Engine-produced embeds

A standalone `!embed[Title](https://example.com/player)` line in an entry's
Markdown body is not raw HTML and does not change the image dialect. The
engine produces an approved player or fallback link at that exact position
in the body, so every look uses its existing `body_html` position. A body
containing only the embed form still has `has_body`. There is no appended
`entry.embeds` field. The fixed, responsive frame and its
link are engine-produced safe HTML, with policy from SPEC.md's embed rules.
Look checks reject literal iframe/object/embed/frame tags, internal
placeholders, and `<{{` / `</{{` names, while allowing attribute sections.
Rendered authored frame elements are neutralised before genuine engine
markers expand: a permitted https target becomes a link; otherwise remove
the tags and keep their text. Private, unpredictable marker capabilities
prevent look-authored placeholders from creating frames. Looks cannot choose
the engine's sandbox/permissions. The outside-request exception is limited to approved
public frames; it never grants remote images, scripts or owner-page players.
The engine enforces the 12-frame cap on the actual selected page, including
repeated bodies. No-embed view/body output remains unchanged.

## 3. The view (what every template receives)

Every page gets:

| Name | What it is |
|---|---|
| `site` | Site-wide words and settings: `site_name`, `logo_text`, `tagline`, `description`, `handle` (X, no @), `x_url`, `follow_label`, `footer_line`, `contact_line`, `contact_email`, `hero_image`, `hero_width`, `hero_height`, `links` (`[{label, url}]`, the owner's menu links, may be empty), `logo` and `logo_alt` (the site's mark, also its icon; may be empty), `follow_image` and `follow_image_alt` (a small round photo of the owner beside the Follow link; may be empty), `updated` (when the site last changed, display-ready), `base_url`, `release` |
| `page` | Home-page words: `lede`, `hero_alt`, `hero_caption`, `cta_label`, `cta_link` |
| `strings` | The template's UI words ("Back to top", "Read the full entry", the 404 sentences, …), with the owner's own words for any of them on top (the site item's `strings`, by name; an empty one keeps the default). The hours and event blocks use them too |
| `nav` | `[{href, label}]` in the owner's section order, only sections with something in them (a stream with entries, any cards, a non-empty About); when the all-stream archive is enabled, append its `/archive/` link labelled with the site's archive title |
| `highlights`, `has_highlights` | All visible formatted cards and whether any exist, independent of the section-menu selection |
| `feeds` | `[{title, url}]` the site's Atom feeds |
| `kit` | `css_url`, `beacon_url` (the kit's analytics beacon, SPEC §8; a template includes it with `<script src="{{kit.beacon_url}}" defer>` and puts `data-kind="{{meta.kind}}" data-id="{{meta.content_id}}"` on `<body>`), `filter_url`, `search_url` |
| `meta` | `title`, `description`, `og_type`, `url`, `image`, `image_alt`, `kind`, `content_id`. `image` is the page's share picture: an entry's share card (SPEC §5), else its cover; on an archive or tag page, the cover of its newest entry that has one; otherwise the site's share image, else its hero |

Listing uses the shared view's `highlights` (visible cards with the same
formatted fields as cards sections) and `has_highlights` on home and on entries
in feature-layout streams (the listing), independently of section-menu selection.
Supporting entries in list-layout streams, archives, tags and the 404 do not
show Highlights. It renders the optional
logical `site.broker` as escaped footer text after the contact information.
Other looks do not render this field.

**Blocks** (on `site`, display-ready in the site's timezone, computed when
the page is served):

- `site.contact`: `has`, `phone`, `phone_href` (tel:), `email`,
  `email_href` (mailto:), `address_lines` (`[{line}]`), `address_one_line`,
  `has_address`, `map_link`, `social` (`[{kind, url}]`), `has_social`.
- `site.hours`: `has`, `days` (`[{day, hours, closed, today}]`, Monday
  first), `status` ("Open now · until 5:00 PM" / "Closed now · opens Tue
  11:00 AM"), `open_now`, `exceptions` (`[{label, when, hours}]`, the next
  60 days), `has_exceptions`, `note`.
- `site.notice`: `has`, `text` (gone by itself after its day).
- `site.buttons`: `[{label, url, note}]`, with `site.has_buttons`.
- `site.palette`: the chosen palette's name. A template's CSS reads colours
  only as `var(--bg | --ink | --muted | --accent | --accent-2 | --line |
  --on-accent)`; the site appends the palette's values after site.css.

**Palettes** (template.json): `"palettes": {"<name>": {"title", "colors":
{bg, ink, muted, accent, accent-2, line, on-accent}}}`, first = default.
Gate: ink and muted at least 4.5:1 on bg, accent 3:1 on bg, on-accent 4.5:1
on accent.

**Streams.** Wherever entries appear, their stream comes with them as
`stream`: `id`, `anchor`, `title`, `byline`, `intro`, `author`, `nav_label`,
`archive_url`, `feed_url`, `all_label`, `link_label`, `see_also` (`{label,
url}` of another stream, or empty), and one layout flag true: `is_feature`
(the newest entry in full, with the notes) or `is_list`. It also supplies
`sort` (`date` or `title`). There may be up to 64 streams; a look must not
assume an eight-stream or twelve-section maximum. New content has unique
stream ids and effective paths (legacy ambiguous paths remain readable,
SPEC §3). The engine supplies the order: templates must not re-sort.

**Home** adds `sections`, in the owner's order, each with exactly one of
`is_entries`, `is_cards`, `is_about` true, plus `not_last`:

- **entries:** `stream`, `show`, `latest` (`[entry]`, the newest by date),
  `more_than_one`, `items` (the first three in the stream's chosen order),
  `all` (every entry in that order),
  `count_suffix` (" (12)" when there are more), `activity` (`[note]`),
  `has_activity`; for events, `upcoming` (soonest first), `earlier`
  (newest first), `has_upcoming`, `has_earlier`, and the stream's entries
  that aren't events, in the stream's chosen order, as `others` and `has_others` (empty
  when the stream has no events).
- **cards:** `anchor`, `title`, `show`, `projects` (`[card]`),
  `has_projects`, `groups` (`[{key, label, count}]`), `has_chips`,
  `by_group` (`[{label, key, cards, style, is_faq, is_steps, is_reviews,
  is_list}]`: menu sections, Experience / Education, FAQ; `style` is what
  the owner says the group is, from the site's `card_groups`, empty when
  they haven't said, so a look needn't guess from names), `open_source`, `has_open_source`, `open_source_label`.
- **about:** `anchor`, `title`, `paragraphs` (`[string]`).

Home also has `has_writing` (show the hero buttons) and `hero_more`
(`{href, label}` of an extra hero button, or empty).

```mustache
{{#sections}}
  {{#is_entries}}{{#stream.is_list}}<section id="{{stream.anchor}}"><h2>{{stream.title}}</h2>{{#items}}…{{/items}}</section>{{/stream.is_list}}{{/is_entries}}
  {{#is_cards}}<section id="{{anchor}}"><h2>{{title}}</h2>{{#projects}}…{{/projects}}</section>{{/is_cards}}
  {{#is_about}}<section id="{{anchor}}"><h2>{{title}}</h2>{{#paragraphs}}<p>{{.}}</p>{{/paragraphs}}</section>{{/is_about}}
{{/sections}}
```

Items carry display-ready values, so templates never format anything:

- **entry:** `title`, `url` (its page, or where it lives when it links
  out), `anchor`, `date`, `date_short` ("Oct 8"), `date_long`
  ("October 8, 2026"), `summary`, `has_body`, `body_html`, `stats`
  `[{value, label}]`, `has_stats`, `tags` `[{name}]`, `has_tags`,
  `cover_src`, `cover_alt`, `external` (links elsewhere), `label` (its link
  text), `link` and `link_host` (a hosted post's other home), `event`
  (`has`, `when`, `date_long`, `date_short`, `time`, `is_past`,
  `place_name`, `place_address`, `map_link`, `rsvp_label`, `rsvp_link`,
  `rsvp_deadline`, `schedule` (`[{time, title, note}]`), `has_schedule`,
  `status` ("Changed" / "Cancelled" / ""), `is_cancelled`, `is_changed`).
- **card:** `name`, `description`, `status`, `status_tone` (`live` or
  `building`), `link`, `link_text`, `as_link` (the whole card is the link),
  `group`, `group_label`, `subtitle`, `period`, `price`, `tags` (`[{name}]`),
  `has_tags`, `image_src`, `image_alt`, `has_image`. A private card is never
  in the view; a mention card comes with `link`, `link_text`, `image_src`
  and `image_alt` empty (SPEC §3).
- **note:** `text`, `date_short`, `link`.

**Entry pages** add `entry`, its `stream`, and `next` (`{href, label}`: the site's main button, or the second when the main one points at this page; or empty). **Archive pages** add `stream`,
`entries`, `tags` (`[{name, count}]`) and `has_tags`; **tag pages** add
`stream`, `tag` and `entries`. Tag pages live at `<archive_url>tags/<name>/`,
and a stream's search index (for the kit's search script) at
`<archive_url>search.json`.

Stream archives, tag pages and search indexes follow `stream.sort` (SPEC
§3). Date order is descending date, descending creation time, ascending item
id. Title order is ascending case-sensitive Unicode scalar comparison of
the validated title, with date order as the tie-breaker. No locale sorting
or case folding. Atom feeds and the home feature's `latest` stay
chronological. Tags and result metadata retain their existing meanings.

**All-stream archive.** Enabled by `site.archive` (SPEC §3), `/archive/`
is an engine page, not another stream or a required template. Its common
responsive shell shows the site's branding, a Home link, title, a GET form
for tag/stream filters and date/stream grouping, and dated summaries with
stream labels and links. Without individual stream archive pages, a stream
label links to `/archive/?stream=<id>` instead of a missing page. It has no
full bodies or players. Its controls
work without JavaScript. The engine owns this page in every look, including
installed looks and the built-in fallback; no theme package format changes
or template upgrades are necessary. The existing `archive.mustache` and
`tag.mustache` remain the individual-stream pages.

The extra navigation item appears only when enabled; templates that render
`nav` get it without changes. Templates that omit `nav` can use an ordinary
owner menu link to `/archive/`. Disabled sites gain no visible markup.
Parity covers the common page alongside each look's sample, with date and
stream grouping, intersecting filters and empty results. Both editions
escape every title, label, summary and control value identically.

## 3b. The catalog

Templates are distributed, not copied: the catalog at
`https://get.porchsite.dev/themes.json` lists every reviewed template
(manifest fields plus `package: {url, sha256, bytes}`), and each package is
the whole template as one JSON file at an immutable, versioned address. A
site installs templates only from the catalog, checking the checksum; a
changed template is a new version. An edition may also bundle templates as
built-ins. A credited look's entry carries `author: {"x": "<handle>"}`
(§3c), and nothing else about its maker; the package never carries credit.

The local authoring gate `npm run theme:check` rejects changed package
bytes at an already published look version and directs the author to bump
`template.json` before proceeding. It compares the same package bytes as
the release script, using an existing local package archive or a local
release tag when ignored archives are absent. Both checks remain active;
neither changes an archive or fetches remote data. New looks and new
unpublished versions pass this version check. Credit is excluded from the
package comparison as in §3c.

## 3c. Credit

Credit for a look is its maker's X handle, and nothing else: no name, email
or link is collected or shown, anywhere.

- **Where it lives.** `themes/credits.json` maps look name to handle
  (`{"harbor": "harbor_maker"}`); the curator keeps it, and its git history
  is the audit trail. The catalog build reads it into each entry's
  `author: {x}`. Credit is the catalog's, not the package's (a package's
  manifest is built without `author_x`), so adding or removing credit is a
  catalog rebuild, never a new version of the look.
- **Claiming it.** A shared look claims credit with `theme_submit`'s
  `author_x` (or its manifest's `author_x`). The queue keeps the handle
  beside the package and answers with a one-time claim code and the words to
  post: "To be credited, post this from @<handle> on X: 'Porchsite look
  <name>: <code>'. The curator checks it before the look is published with
  your name; until then it is published without credit."
- **Verifying it.** The curator sees each submission's claimed handle and
  code, checks that the post is on X from that account, and publishes with
  `credit_verified` true or false (a look that claims credit can't be
  published without saying which). Only a verified handle reaches
  `credits.json`; an unverified one is dropped (the handle and code are
  deleted) and the look is published without credit. A rejected look's
  handle is dropped too.
- **Following it.** The sharing site sees where its claim stands in
  `theme_list`'s `my_submissions`: `credit` is `waiting` (not checked yet),
  `credited`, or `not credited` (unverified, rejected, or removed). Only a
  look that claimed credit has it. The queue's status answer never carries
  the handle or the code.
- **Removing it.** The maker asks the curator (through a theme request, the
  form at `https://porchsite.dev/ask`, or by contacting the Porchsite author
  on X). The curator removes it on the
  queue and deletes the line from `credits.json`; the next catalog build
  publishes the look without credit.
- **Where it shows.** The catalog entry (`author: {x}`), `theme_list`'s
  catalog (`author_x`), the look's demo site ("by @handle", linking to
  `https://x.com/<handle>`), and the curator's review view.

## 4. Contributing a template

A template is one folder in `themes/` of this repository, sent as a pull
request (or submitted from a site with `theme_submit`, for the curator to
review).
A maintainer runs the checks locally (there is no hosted CI): the rules
above, the template rendered with sample content for every page and kind it
claims, and phone and desktop screenshots; looks at the screenshots and
merges. Every release runs the same checks again among its local gates. The gallery credits the maker by X handle, once verified (§3c).

## Open questions

- **T-Q1.** A manifest `strings` block (a look's own defaults) was in draft
  0 and isn't built yet. Owner overrides are (the site's `strings`).
- **T-Q2.** Do feeds (Atom) stay edition-rendered (no template)? Proposed: yes.
- **T-Q3.** Per-template settings (accent colour, font choice) as typed
  values in the manifest that the owner can change without editing CSS.
