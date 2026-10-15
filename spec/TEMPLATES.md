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
├── archive.mustache     # a stream's entries, newest first (required)
├── tag.mustache         # a stream's entries with one tag (required)
├── not_found.mustache   # the 404 page (required)
├── partials/            # optional *.mustache, used as {{> name}}
└── static/              # site.css (required) and the template's scripts,
                         # served at /static/<file>
```

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

`sections`: the home section kinds the template draws. `layouts`: the stream
layouts it draws (a stream set to a layout the template lacks is drawn as
`list`).

## 2. The rules

- **Mustache only:** variables, sections, inverted sections, partials.
  No lambdas, no delimiter changes. A value the view doesn't have is an
  error in the Python edition, so templates may use only what's listed here.
- **Triple braces only for `*_html`.** `{{{body_html}}}` is allowed because
  the edition produced that HTML itself (rendered Markdown, safe; the
  dialect is in SPEC.md §3). It can hold `<h1>` to `<h6>`, `<p>`, `<br>`,
  `<ul>`/`<ol>` (nested; `<ol start>`), `<blockquote>`, `<hr>`,
  `<pre><code>`, `<code>`, `<em>`, `<strong>`, `<a>` and `<img>`, so a look
  styles all of them.
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
Look packages still cannot contain iframe/object/embed tags, the engine's
internal `porchsite-embed` placeholders, or choose their
sandbox/permissions. The outside-request exception is limited to approved
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
| `nav` | `[{href, label}]` in the owner's section order, only sections with something in them (a stream with entries, any cards, a non-empty About) |
| `feeds` | `[{title, url}]` the site's Atom feeds |
| `kit` | `css_url`, `beacon_url` (the kit's analytics beacon, SPEC §8; a template includes it with `<script src="{{kit.beacon_url}}" defer>` and puts `data-kind="{{meta.kind}}" data-id="{{meta.content_id}}"` on `<body>`), `filter_url`, `search_url` |
| `meta` | `title`, `description`, `og_type`, `url`, `image`, `image_alt`, `kind`, `content_id`. `image` is the page's share picture: an entry's share card (SPEC §5), else its cover; on an archive or tag page, the cover of its newest entry that has one; otherwise the site's share image, else its hero |

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
(the newest entry in full, with the notes) or `is_list`.

**Home** adds `sections`, in the owner's order, each with exactly one of
`is_entries`, `is_cards`, `is_about` true, plus `not_last`:

- **entries:** `stream`, `show`, `latest` (`[entry]`, the newest),
  `more_than_one`, `items` (the newest three), `all` (every entry),
  `count_suffix` (" (12)" when there are more), `activity` (`[note]`),
  `has_activity`; for events, `upcoming` (soonest first), `earlier`
  (newest first), `has_upcoming`, `has_earlier`, and the stream's entries
  that aren't events, newest first, as `others` and `has_others` (empty
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

## 3b. The catalog

Templates are distributed, not copied: the catalog at
`https://get.porchsite.dev/themes.json` lists every reviewed template
(manifest fields plus `package: {url, sha256, bytes}`), and each package is
the whole template as one JSON file at an immutable, versioned address. A
site installs templates only from the catalog, checking the checksum; a
changed template is a new version. An edition may also bundle templates as
built-ins. A credited look's entry carries `author: {"x": "<handle>"}`
(§3c), and nothing else about its maker; the package never carries credit.

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
