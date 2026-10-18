# Sitekeeper spec (draft 0)

Sitekeeper is a personal website that your AI assistant keeps up to date and
that never changes without your yes. This document is the contract. Any
implementation that follows it, and passes the conformance tests, is a
Sitekeeper site, whatever language or host it runs on.

Two editions implement it, both in this repository:

- **Cloudflare edition** (`cloudflare/`): Cloudflare Workers + D1 + KV
  (images in D1 too: R2 needs a dashboard step and a card on file, which an
  assistant can't do for its person). Installed by the owner's assistant on
  the free tier, for people who never want to see a server.
- **Server edition** (`server/`): Python + PostgreSQL, for people who run
  their own host.

This folder (`spec/`) holds the contract, the conformance check and the
template format. Both editions follow it; neither defines it.

Before protocol construction, content/access lookup or routing, the Worker
answers every non-loopback HTTP request with an empty 301 to the same URL on
HTTPS and `Cache-Control: no-store` (all methods, paths and query strings).
Loopback development (`localhost`, IPv4 127/8 and IPv6 ::1) remains HTTP-capable.
The server edition requires its reverse proxy to terminate TLS and redirect
external HTTP to HTTPS. The application does not redirect by request scheme:
plain HTTP upstream requests with the site's public Host must keep working.

`scripts/parity.sh` compares every look's rendered sample pages and its
`site_check` and `site_state` answers in both editions. Tool comparisons
use the same item ids, versions and clock; JSON object keys may differ
in order, but no response fields are removed before comparing. The check
also covers equivalent external URLs and links built from `site.base_url`.

## 1. Roles

| Role | Who | How they get in | What they can do |
|---|---|---|---|
| **Owner** | The person the site belongs to | A passkey (Face ID, fingerprint, device PIN) | Everything, and the only one who can publish |
| **Assistant** | The owner's AI assistant | OAuth through the site's MCP endpoint, approved once by the owner with their passkey | Read the site, draft changes, ask for approval, undo its own drafts |
| **Visitor** | Anyone | Nothing | Read what's published |

There is exactly one owner per site. An assistant's access can be revoked by
the owner at any time.

## 2. The safety rules (normative)

These are the reason Sitekeeper exists. An implementation that breaks one is
not a Sitekeeper site.

- **S1. Drafts only.** An assistant can create, change and remove content, but
  nothing it does reaches the public site until the owner approves it.
  There is no tool, flag or setting that lets an assistant publish.
- **S2. The owner sees what they approve.** An approval names specific items
  at specific versions. The owner sees each one as the site will show it, and
  what changed since the live version. If an item changes after the request,
  the request no longer covers it.
- **S3. No lost updates.** Every change to an existing item names the version
  it was based on. A change based on an old version is refused
  (`version_conflict`); the assistant must re-read and redo it.
- **S4. Retries are safe.** A create carries an idempotency key. Sending the
  same request twice creates one item, and the second reply matches the first.
- **S5. Nothing is ever lost.** Every version of every item is kept. Any item
  can be rolled back to any earlier version, and the whole site to any
  earlier publish. A removal is a version too.
- **S6. Content is checked on every write.** Before saving, the site rejects
  content that matches the owner's guard rules (credentials, private names,
  anything the owner lists). The guard runs on drafts, not only at publish.
  A private card's name is a private name (§3): no other item may contain
  it, and publishing re-checks everything that would be public.
- **S7. No hotlinks.** Images in content are copied into the site's own
  storage when saved. A published page never depends on someone else's host.
- **S8. One error shape.** Every refusal has a stable machine-readable `error`
  code and a human sentence `message`, the same over MCP and HTTP.

## 3. Content model

Everything on the site is an **item**: `{ id, kind, slug, version, data, deleted }`.
Kinds in draft 0:

| Kind | What it is | Notes |
|---|---|---|
| `site` | Standing text and identity: site name, tagline, intro, about, owner's name, links, section titles, which sections show and in what order, hero image, `card_groups` (what kind each card group is: FAQ, steps, reviews, a plain list), and `strings` (the owner's words for any of the look's own, by name: another language, a different "Back to top") | Exactly one item. Every word on the site that isn't an entry comes from here. |
| `entry` | A dated post in one of the site's **streams** (e.g. the assistant's journal, the owner's writing, a trip log) | stream, title, date, summary, body (Markdown), tags, cover image, status (`draft` / `ready`); optional `stats` (`[{value, label}]` tiles), `external_url` (the post lives elsewhere; the site lists it and links out) and `slug` (its address; see below) |
| `card` | A project, product, service or anything shown as a card | name, description, link, status label, group, sort order, visibility (`public` / `mention` / `private`) |
| `note` | A one-line dated activity item | text, date, optional link |

**Streams.** The `site` item lists the site's streams, each with an id, a
title, a byline, a layout (a dated list, or cards with each entry's cover)
and the label for links out (entries with `external_url`). Every stream gets
its own home section, its
own archive page and its own feed, with no code changes. A new site starts
with one stream; adding one is an ordinary approved change to the `site`
item. A site has 1 to 64 streams. `sections` allows up to 68 distinct
entries, retaining `entries` as shorthand for streams not named separately.
Stream ids must be unique. New writes also require unique effective paths
(`path`, or `id`); pre-existing ambiguous paths retain their old routing
until edited rather than making an existing site unreadable.
An entry belongs to exactly one stream. Notes are listed newest date first;
on the same date, the one created later comes first. A stream's `dated_addresses`
(boolean, default `true`) decides how its new entries' addresses are made.

**Stream order.** Each stream has `sort: "date" | "title"` (default
`"date"`). Date order is newest entry date first, then newest creation time,
then item id ascending. Title order compares the validated title's Unicode
scalar values, case-sensitive, ascending, with date order as the tie-breaker;
there is no locale-dependent comparison or case folding. This controls
the stream's home `items` and `all`, archive, tag pages and search index.
The home `latest` and feature layout's full entry remain the newest by
date, even in a title-sorted stream; `items` remains limited to three.
Event groups keep their existing upcoming/earlier ordering; non-event
`others` follows the stream's sort. Feeds remain newest-date-first, limited
to 20, independent of display order. Slugs, addresses, approval order and
the meaning of authored dates do not change.

**All-stream archive.** The site setting
`archive: {enabled: boolean, title: string}` defaults to
`{enabled: false, title: "All entries"}`. The title is trimmed, non-empty,
at most 60 characters. Enabling it is an ordinary site-item change requiring
owner approval. It adds `/archive/`, an archive of every approved, non-draft
entry across all configured streams, including streams omitted from the
home sections. External entries have their usual outgoing links. Cards and
notes are excluded. Each result identifies its stream by its configured
title and links to that stream's archive. When the selected look is missing
or uses the built-in fallback without individual stream archives, that link
is `/archive/?stream=<id>` instead. There are no entry bodies or
embedded players on this page: titles, dates, summaries, stream labels and
tags are enough to choose an entry.

The reader chooses a chronological list or grouping by stream (for example,
by project), and can filter by a tag and/or stream. Controls are an ordinary
GET form that works without JavaScript: `/archive/?sort=date|stream`,
`tag=<tag>` and `stream=<stream id>`. Missing or empty controls mean date
order and no filter. Date order uses the ordering above; stream order groups
by the site's configured stream order, with date order within each group,
independent of individual streams' `sort`. Filters intersect. Filter choices
come only from published entries and configured streams; show counts for
tags before filtering, deduplicating a repeated tag within an entry. An
unknown but syntactically valid tag or stream produces an empty result,
never a fallback to an unfiltered list. Empty results retain the controls
and say that no entries match. Tags use `[a-z0-9-]{1,30}`; stream ids use
`[a-z][a-z0-9-]{0,29}`, matching item validation. Compare decoded values
exactly; never interpret a filter as HTML, SQL, a path or a redirect.
Reject duplicate controls, unknown parameter names, invalid tag/id syntax,
and unsupported sort values with `400` before
rendering; the private-content gate runs before these refusals.

When enabled, append a navigation link labelled with `archive.title` after
the ordinary section links, and include the canonical `/archive/` in the
sitemap even when empty. Filtered URLs are not added to the sitemap. Public
archive variants use the normalized filter URL as their HTML canonical,
as specified in AF-2; the unfiltered page uses `/archive/`. The archive's
`lastmod` is the newest site/member-entry approval date. `/archive` redirects
to `/archive/` preserving its query. Enabling is refused with `invalid` if
any stream id or effective path is `archive`, so an existing stream is never
silently displaced. Disabled sites retain existing stream routing at that
name, or the usual 404. New writes with other duplicate stream paths are
also refused, without changing how untouched legacy content is read.

The archive is an engine-rendered content page, available with every look
and the built-in fallback. It uses the site's branding and the engine's
responsive page shell, with a Home link and normal entry links; no new
template file, installed-look upgrade, remote request or client script is
required. It obeys the same private-site access, CSP, no-transform and
cache policies as other content pages. No new permission, public draft
lookup, assistant tool, approval bypass or private-site access is added.
Quick `site_check` recognises its URLs only when enabled; deep checking
can traverse its entry links when the rendered home links to it, within
the existing crawl budgets. Merely enabling an unlinked page does not
establish reachability for a look that omits navigation.

**Entry addresses.** An entry's page is `/<stream path>/<slug>/` (the
stream's `path`, or its id). The `slug` is kept on the item, not in its
data, and is made once, when the entry is created: from its date and title
words (`2026-10-09-how-it-works`), or from the title words alone
(`how-it-works`) when its stream's `dated_addresses` is `false`. Editing the
title later never changes it. An assistant may choose it instead by sending
`slug` with the entry's data on create or update: lowercase letters, digits
and dashes, not first or last, 1 to 80 characters. A slug another entry has
is refused (`slug_taken`). When an update changes the slug, the old one is
recorded with the version that changed it: `item_history` shows that
version's `address_change` (`{from, to}`), the approval page says "Address
changes from /x/ to /y/", and once the change is live the old address
(under the stream's path or id, or the old `/e/<slug>/`) answers `301` to the
entry's current page; it is checked only for an address that would
otherwise be a 404. The redirect follows the entry: removing it ends it. A
rollback or whole-site revert keeps the current slug.

**Discovery.** `GET /sitemap.xml` serves an XML sitemap (sitemaps.org
namespace), with absolute URLs using the request's site origin. It reads
only approved live content: home first, then every non-draft local entry,
then each configured stream archive and its tags in stream order (tag names
sorted). External-URL entries are redirects and never get their own sitemap
entry. Their published summaries may still contribute to archive/tag pages.
Archive/tag URLs are included only when the current look is available and
those pages are reachable; a missing look's built-in fallback has local
entry pages but no stream archives. Empty configured archives remain
reachable. No owner, review, setup, preview, deleted or unpublished item is
listed, and old redirected addresses, feeds and search indexes are omitted.

`lastmod` uses UTC ISO dates (`YYYY-MM-DD`) from approval timestamps, never
an entry's authored date or draft edit time. A local entry uses its own live
approval time. Home uses the newest approval among the site and visible
entries/cards/notes; an archive uses the newest site/member-entry approval;
a tag uses the newest site/matching-entry approval. Missing approval dates
are omitted rather than invented. URLs are XML-escaped and deduplicated.
The response is `application/xml; charset=utf-8`, with the same
`Cache-Control: public, max-age=300` as Atom feeds. HEAD follows GET's status
and headers without the body. Both editions return identical sitemap bytes.

`GET /robots.txt` retains `User-agent: *` and `Allow: /`, and appends
`Sitemap: <site origin>/sitemap.xml` with a final newline. This intentionally
changes robots bytes; its existing one-hour cache policy is unchanged.
No content/schema/tool contract changes are needed for discovery. Sample
parity includes sitemap and robots at a fixed origin and approval clock.

**Card visibility.** A card is `public` (the default: the whole card shows),
`mention` (only its name and description show: no link, no link text, no
picture, badge, group, subtitle, period, price or tags) or `private` (it never shows). The rules, checked on every save
(refusals in brackets):

- No item may contain a private card's name, as a whole word in any case
  (`content_guard`); a card may name itself, and a private card's own text
  is never public, so it isn't checked for other private names.
- A card can't be made private while other items still name it
  (`name_in_use`, with the ids).
- An entry names a mention card at most once in its summary and once in its
  body: one line, nothing more (`mention_limit`).
- A rollback, or a whole-site revert, never makes a card more visible than
  it is: raising visibility is always a change of its own.
- Publishing (an approval, the owner's own publish, a revert) is refused,
  with nothing changed, if any public text of the site as it would be names
  a private card, private there or in the current drafts (`content_guard`).
- The approval page and its preview warn about every card a change shows
  more of (private → mention → public).

**Markdown.** An entry's body and the site's about text are Markdown, in
one small dialect both editions render to the same bytes. The cases in
`spec/markdown-cases.json` are normative; both editions' tests run them.

- Blocks: paragraphs; `#` to `######` headings; `-`, `*` or `+` lists and
  numbered lists (`1.` or `1)`; a list that starts at another number keeps
  it), nested by indenting under the item's text (two spaces is enough
  under a number); `>` quotes; `---`, `***` or `___` rules; code fenced
  with ```` ``` ```` or `~~~` (the word after the fence becomes
  `class="language-x"`) or indented four spaces. A heading, list, quote,
  fence or rule line ends the paragraph above it, except that only `1.`
  starts a numbered list there (`1999. A good year.` stays text); inside a
  list item any number does. A list with a blank line between its items
  wraps each item's text in `<p>`.
- Pipe tables (MD-1): a single header line containing an unescaped `|`,
  immediately followed by a delimiter line with the same number of cells.
  Each delimiter cell is one or more `-` with an optional `:` at either
  end: left, right, or both for centered alignment. Boundary pipes are
  optional; ASCII space/tab padding is removed. A backslash-escaped pipe
  stays in its cell, including within inline code; unescaped pipes split
  cells even within code. Ordinary inline Markdown is parsed in each cell.
  Data rows continue to a blank line or another block. Short rows gain
  empty cells; extra cells are ignored. A header-only table has no body.
  This is the core [GFM table syntax](https://github.github.com/gfm/#tables-extension-),
  within this engine's existing block and inline dialect.
  Tables may begin at a block boundary or interrupt a paragraph when the
  next two lines form a valid header/delimiter pair. Fenced and indented
  code keep precedence. Quotes and list items support tables after their
  normal container prefixes are stripped. A standalone engine block ends
  a top-level table and is emitted once; cells never expand engine embeds.
  Header cells render as `<th scope="col">`; data cells use `<td>`, with
  `align="left|center|right"` only for explicit column alignment. The
  engine emits `<table><thead><tr>...` and optional `<tbody>` rows, within
  `<div class="md-table" tabindex="0" style="max-width:100%;overflow-x:auto">`.
  The table has `style="border-spacing:0.75em 0.35em;overflow-wrap:normal"`. These fixed styles
  provide spacing, normal word wrapping (overriding inherited
  `overflow-wrap:anywhere`) and keyboard-reachable horizontal scrolling on narrow
  screens without changing a look or accepting authored styles.
  Recognition is limited to 64 columns; a wider candidate stays ordinary
  Markdown. A document, including all nested containers, may generate at
  most 4,096 table cells, including headers and padded empty cells. A
  header that does not fit remains ordinary Markdown. Before a body row
  would exceed the remaining budget, close the table and resume ordinary
  block parsing at that row. No source is truncated or rejected. The
  splitter and recognition are linear in the input being examined; no
  delimiter or padding can cause unbounded generated output. Shared cases
  prove the grammar, boundaries, escaping, limits and exact bytes.
- Inline: `*em*` / `_em_`, `**strong**` / `__strong__` (underscores inside
  a word, as in `snake_case`, stay as they are), `` `code` ``, links
  `[text](address "optional title")`, images `![alt](/media/…)`, and a
  backslash before punctuation to show it as is.
- Lines: a single line break inside a paragraph is a space; a line ending in
  two spaces or a backslash breaks the line (`<br>`).
- Punctuation: straight quotes become curly (`it's` → `it’s`, `"a"` →
  `“a”`), `--` an en dash, `---` an em dash, `...` an ellipsis; never inside
  code, link addresses, titles, alt text, or a bare `http(s)://` address.
- Safety: raw HTML is escaped, never passed through. Links go only to
  `http://`, `https://`, `mailto:`, `tel:`, `/…` or `#…` addresses, anything else
  stays text. A `tel:` destination contains at least one ASCII digit and
  otherwise only ASCII digits, `+`, `-`, balanced parentheses and literal
  spaces; no letters, extensions, percent escapes, tabs or newlines. For
  example, `[Call](tel:+1 (202) 555-0123)` is a link. Optional quoted titles
  work as on other links. `mailto:` behavior is unchanged.
  Images only to the site's own `/media/` files (any other
  image renders as a plain link, or as text).

Templates decide how kinds look, never what they say (see §6).

### Versioned site fields and Listing content

Both editions accept optional `site.broker`: plain text of at most 160
characters, default empty, never interpreted as Markdown. The Listing look
shows it in small footer text after the agent/contact information. Other
looks ignore it. `site_state`, review, history and restore expose the logical
field at its exact site version.

Store extensible site fields in additive `site_fields` rows keyed by
`(version, key)`, with a JSON value and an approval mark. The allowlisted
keys are `broker` and `private`; the table is not an arbitrary input-key escape hatch.
`SiteData` and all persisted items/revisions/live JSON retain the previous
release's strict key set. A normal site content write stores the logical
field alongside the same immutable version. Only owner publish marks that
version approved, and public views use only the approved matching live
version. Missing rows/tables and unapproved versions yield the empty value;
values never inherit across versions. An empty value is represented by an
absent row at that exact version, which records a removal without inheriting
older values. Restore,
rollback, import and whole-site revert use the same version and approval
paths. A previous runtime publishing an unseen draft cannot approve its
new fields. No existing embed-source authority is moved or widened.

Listing renders all published visible cards, including mention-only cards
without their private link or picture, in a Highlights section on home and
entry pages. Private/unpublished cards remain absent. This section follows
the stat rail and precedes the listing body; phone layouts use one column.
Its hero-image advisory is 1600 pixels wide (about 1600 by 900 for the crop),
not an upload requirement. Existing photo shrinking and size limits remain.

### Private sites and reader access

Both editions accept optional boolean `site.private` (default false) as an
allowlisted exact-version `site_fields` key. It never enters legacy item,
revision or live JSON. Only owner approval publishes the field; absent or
false at that live version is public, with no inheritance from older versions.
New-code approval also writes an exact-version receipt in a NEW table; the gate requires it, because prior code marks every site_fields key approved. A prior runtime cannot create that receipt. Import refuses a site `private` key before saving anything. Review, site-item
rollback and whole-site revert prominently say **This makes the site public.**
when the proposed version would turn private off. When turning private on,
tell the owner that earlier search-engine copies and pictures already fetched
cannot be recalled. Previously authorized in-flight bytes cannot be recalled.

A denied private gated GET/HEAD with no `Authorization` header receives
this exact unbranded UTF-8 document (111 bytes, no trailing newline):
`<!doctype html><meta name="robots" content="noindex"><title></title><a href="/login?next=%2Freview">Sign in</a>`.
The link is fixed: no requested path, query, site name, title text, look,
item existence or credential is interpolated. Real and missing addresses,
Accept values and invalid/expired/revoked cookies share these bytes. The
existing login sends a reader passkey session to `/` and an owner session
to `/review`. The existing `safeNext` grammar is unchanged.

Any `Authorization` header, including empty, unknown, writer, published-read
or other schemes, retains the legacy exact 68-byte `BLANK` document:
`<!doctype html><meta name="robots" content="noindex"><title></title>`.
Non-GET/HEAD denials also retain BLANK. These display rules confer no new
read, draft, review or agent authority. Authorized owner/reader pages and
existing owner-route refusals are unchanged.

Both denial documents have status 404 and no Location, ETag, Last-Modified,
Link or Vary. Headers include `Cache-Control: private, no-store, no-transform`,
`Content-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'`
and `X-Robots-Tag: noindex`; the Sign in document also has
`X-Content-Type-Options: nosniff`. It has no inline style or script. This
intentionally replaces the former blank-page assertion for browser reads,
including feeds, media misses and new AF paths; it preserves the old exact
credential refusal. The fixture `spec/fixtures/private-denial.json` binds
both editions. Required paired cases: `pv6_uniform_denial`,
`pv6_authorization_blank`, `pv6_gate_before_content`, `pv6_head_metadata`,
`pv6_reader_owner_signin`, `pv6_protocol_unchanged` and `pv6_upgrade`.
GET and HEAD have matching status/headers (HEAD has no body). Check access
before constructing a live view, looking up media or resolving redirects.
This covers pages, misses, entries, tags, feeds, sitemap, search JSON, media,
share cards, old addresses, missing slashes and `/review` owner routes.
`/robots.txt` instead returns `User-agent: *\nDisallow: /\n`, without a
Sitemap line. Every gated response while private, including authorized
responses, errors and redirects, is `private, no-store, no-transform`; conditional requests
never bypass authentication or reuse another actor's cached body.
Anonymous `/collect` requests make no analytics writes while private.

### Media and stored-copy cache policy (SV-PV2)

A content hash makes bytes stable; it does not make publication or
permission permanent. Both editions send successful anonymous public media,
including generated share pictures, with
`Cache-Control: no-cache, no-transform`. There is no `public`, `immutable`,
positive freshness lifetime, `stale-while-revalidate` or `stale-if-error`.
Every reuse must consult the origin before showing stored bytes. Media
also gets an ETag, so a still-published unchanged image can revalidate with
a bodyless 304 instead of a full download. This replaces the long media
lifetime; it does not change the separate AF page/feed policy.

Binary media keeps its body-validator encoding (public text uses AF-2
dependency validators): SHA-256 of the canonical
absolute media URL's UTF-8 bytes, a zero byte, the exact Content-Type's UTF-8
bytes, a zero byte, the public Content-Signal's UTF-8 bytes (empty if media
emits none), a zero byte, then the stored image bytes without any text
conversion. The ETag is `W/"sha256-<64 lowercase hex digits>"`. Neither
session data nor publication state is hash input: publication is checked
before a conditional response. Both editions use identical input and tags.
Apply AF-2's If-None-Match grammar, weak comparison, wildcard and precedence
rules only after those checks. A matching successful anonymous GET or HEAD
returns 304 with the same ETag and cache policy as GET, no body and no
nonzero Content-Length. A non-match or malformed field gets the ordinary
successful response. Owner and reader responses do not reuse this anonymous
validator or return 304 from it.

For every media GET or HEAD, private-site access and current publication
checks run before byte lookup, shared-copy lookup or conditional handling.
Requests carrying either owner or reader session cookie, or Authorization,
are `private, no-store, no-transform` even on a public site, including
expired or invalid credentials. They get no validators. The proxy must
bypass cache reads and writes for both session cookies and Authorization. A private denied request retains the request-appropriate 404 document (§3)
and private headers already specified. A public media miss or an image no
longer referenced by published content returns 404 with `no-store`, without
old bytes, a success redirect or a validator. An already-authorized
in-flight response follows the existing private-mode limitation.

This extends agent-friendly invariant 16: engine-managed HTML, Markdown,
llms and media copies must not outlive their source's publication or access
decision. Unpublishing an item, deleting it from the live view, changing
card visibility, turning private on, restoring an earlier publish or
replacing live content invalidates every affected representation and its
validators as part of the change's committed visibility boundary, before
the next newly authorized response. Use a transactional generation or
equivalent serialization; an earlier concurrent build cannot refill a
current-generation cache with old public bytes. Deleting all managed copies
is acceptable when dependency-specific invalidation cannot prove coverage.
Draft edits do not invalidate or publish live content. Removing an item's
last reference to an image ends its anonymous availability; an image still
used by another published item remains available. Kept history is not a
public reference.

On a newly started request after the change commits, the same old URL with
its former ETag must run the current checks: it cannot get 304 from an old
copy after unpublish or private-on. Private authorization precedes all
validators and negotiations, including Markdown and AF stored-copy reads.
HEAD must agree with GET's status and headers and have an empty body.
Authorization and current publication checks are mandatory before every
media 304, including `If-None-Match: *`.

The engine cannot delete a browser's previously fresh immutable copy, a
third-party archive, downloaded files, or caches outside its control. Before
enabling private mode, the deployment procedure disables shared proxy/CDN
caching and purges all operator-controlled public copies, including media
and redirects. Public-cache operators must purge affected copies on
unpublish and never serve stale content, including on an origin 404 or
failure. A proxy can store a no-cache response; the origin header cannot
override a proxy configured to ignore revalidation or serve stale data.
These proxy requirements remain mandatory after the new origin policy
ships. Remove the interim no-store media override only after verifying that
every intervening cache honors no-cache and has stale reuse disabled.
Until these requirements are met, do not claim that the deployment
enforces immediate removal of cached public content. Existing cached copies
remain the accepted residual stated in the private-mode documentation.

Acceptance requires identical media status/headers/bytes in both editions,
with public, owner, reader and private-anonymous GET/HEAD cases; matching,
nonmatching, weak/strong, wildcard, list and malformed If-None-Match fields;
an unchanged image's bodyless 304; unpublishing the last reference and
retaining another published reference; and private-on after warming every
managed representation. Warm public tags and `*` must give 404, never 304,
after last-reference removal or private-on. Authenticated responses must
remain private/no-store and must not answer 304 from a public tag.
Include a stalled cache build racing the visibility change and prove it
cannot repopulate the new generation. A disposable local proxy must prove
both-cookie isolation, origin 404 passthrough, no stale image on upstream
failure, and cold/warm/conditional behavior. Tests must create no real
external cache or production data. Media is read from storage after current
access and publication checks on each request; there is no engine-managed
media response cache to refill.
The managed HTML/Markdown/llms generation requirements above apply when
those representations are cached. Rolling back restores the previous
release's media headers but preserves its publication checks and stored
bytes; operators must keep the proxy safeguards in place.

Private mode hides published site content, not the routes needed to sign in,
claim or recover the site, connect an assistant, or check releases. Setup
redirects after claim. The release endpoint reveals only release id and the
private-mode minimum; OAuth metadata describes the connection protocol.
These routes never show site content.

Open paths are an exact route-and-method allowlist, never whole prefixes:
GET/HEAD `/login`, `/setup`, `/recover`, `/.well-known/porchsite-release`;
POST `/login/options`, `/login/verify`, `/setup/options`, `/setup/verify`,
`/recover/options`, `/recover/verify`; and the concrete protocol endpoints
`/mcp`, `/authorize`, `/oauth/token`, `/oauth/register`,
`/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`. Protocol handlers retain their
own method checks. Upload links match `/upload/<token>` (GET/HEAD/POST),
owner add-passkey and reader links match `/passkey/<token>` and
`/invite/<token>` (GET/HEAD), with only `/options` and `/verify` suffixes
(POST). Tokens match exactly 32 characters from `[A-Za-z0-9_-]`. These
links retain capability authorization without site-content decoration.
Cancellation and replacement of sign-in tokens serialize with issuance.
Every issuance checks that its conditional token consumption affected one row
in the same transaction as credential/session creation; zero rows refuses.
Unknown paths, extra segments, malformed tokens and unmatched methods are
gated. Independently of the route allowlist, every request-backed live-view
renderer and themed not-found fallback rechecks private-site access before
constructing any site view; an anonymous private request returns the same
blank response even if routing wrongly lets it reach that renderer. Anonymous
`/authorize` retains its owner login redirect. Readers on `/review` or
`/authorize` receive 303 to `/`; their login destination is always `/`.
Readers cannot approve, import, revert, invite, create owner passkeys, use
MCP or see drafts, history, stats or owner previews. Owners retain their
existing authority. A revoked reader is an anonymous visitor.

The owner creates, lists and revokes reader invites and readers at
`/review/readers`, with owner CSRF on every write and no MCP invite tool.
Invites are hashed at rest, seven days, single use, spent only on successful
registration, recording that completion as the reader's last sign-in. Their pages use no-referrer/no-store headers and remove the
token from the address bar. Each reader registers a distinct discoverable
passkey through the same origin; `/login` sends no allowCredentials list.
Reader credentials and sessions live in NEW tables; they never enter owner
`passkeys` or `sessions`, even for compatibility with older releases. Reader
cookies are `__Host-sk_reader`; owner cookies remain `__Host-sk_owner`, both
HttpOnly, Secure, SameSite=Lax, Path=/. Unknown credentials have one generic
error. Reader CSRF never authorizes owner operations.

Auth state and epoch metadata also live in NEW tables. Every authorization
checks that the credential is still active and its session epoch is current.
Capture the expected epoch at challenge or verification time; conditional
issuance compares that captured value with the current epoch. Reading the
latest epoch at INSERT and stamping it is not fencing. Login, owner add-link,
invite completion and recovery conditionally issue credentials/sessions in
one atomic operation; stale operations fail after revoke/recovery commits.
Revoking a reader atomically bumps its epoch and deletes its sessions. Fresh
legitimate owner additions after recovery still work; setup is unchanged.
Every authorization after commit fails for revoked credentials; responses
already authorized before commit may finish. Both editions test controlled
login/revoke, add/recovery, invite/revoke and recovery/recovery interleavings.

### Recovering an owner

`/recover` is separate from setup, reachable while private, and refused on
an unclaimed site. A hosting-account operator issues a one-time stored code,
with at least 24 random bytes, hashed at rest, replacement invalidating prior
codes, and a default expiry of 24 hours. This is never an MCP tool. Recovery
uses setup-class no-referrer/no-store headers, address-bar stripping and
bad_code/code_expired errors. `/setup` remains closed after claim.

Recovery is ONE all-or-nothing transaction: spend the valid code; bump the
owner epoch; delete all owner passkeys, unused add-passkey links, owner
sessions, reader sessions and all unused reader invites; invalidate in-flight issuance by captured
epoch comparison; insert the newly verified owner passkey and fresh owner
session. Keep reader passkeys; their next legitimate login works at the new
reader epoch. Concurrent completion of one recovery code has one winner.
Hosting-account control already grants owner-equivalent authority; recovery
does not protect against a hosting-account compromise.

### Owner-approved embeds

This applies identically to both editions. S7 continues to require
local copies of images; the frames below are an explicit, owner-approved
exception for video and tour players, not an image hotlink or outside script.

**Content and authority.** Add `site.embed_sources`, an ordered list of at
most 20 distinct canonical HTTPS origins, default `[]`.

The tool/view field is logical, not a key in stored site JSON. Store each
site version's source list in an additive `site_embed_sources` table;
`items.data`, `revisions.data` and `live.data` contain only fields understood
by the previous release. Save the source list atomically with its exact
site version. Only the owner's approval/publish path marks that version's
list approved; public authority requires both that mark and the matching
live site version. A previous bundle publishing a draft cannot grant new
frame authority it never showed for approval. Reads, review, rollback and
whole-site revert reconstruct the logical field from the same version.
An absent list is empty, never an inherited list from another version.

Any content write or approval action (request, owner decision or publish
now) repairs legacy inline lists; no approval is required after a content
write. Boot and read-only requests do not run the repair. Atomically move
any legacy inline lists out of all current, revision and live site snapshots, preserving
versions and the already-live authority without approving staged sources.
Conflicting lists for one version refuse the repair rather than guessing.
Keep old JSON free of the key on every subsequent write and publish, so a
rollback needs no reverse schema migration. New tables are ignored by the
previous bundle; new body markup may degrade to literal text.

Rollback payload audit against the previous release: `embed_sources` and
`broker` are the new logical site/content fields; both live outside legacy
JSON. Entry/card/note stored key sets,
settings and existing media/analytics columns gain no new keys. Image
privacy changes only existing byte/hash values; coalesced analytics changes
existing cumulative values and sending cadence. Tool guidance/response
notes are not persisted content fields. The new source-version table is
additive and ignored by old code; future photo batches likewise use only
new tables, not new keys in validated item or settings JSON.

Place a player in
`entry.body` with a line containing only:

```
!embed[Title](https://example.com/player)
```

The title is non-empty single-line text, at most 200 characters; the URL is
absolute HTTPS, at most 2,000 characters, subject to the URL rules below.
Only `entry.body` recognises the form: never site about/intro, summaries,
notes, cards, titles or other Markdown/text fields. The opening `!embed`
must start at column zero, with no leading/trailing characters or spaces
on that line. Fenced code (backtick or tilde), indented code, inline code,
blockquotes and list-prefixed examples do not recognise it. A backslash
before `!` escapes the form and never creates a player. In all these
literal cases preserve ordinary Markdown code/escape presentation without
turning the embed URL into a link or an image. Elsewhere an inline form is
literal text, not an embed or an ordinary Markdown link. An invalid standalone form also stays escaped literal text. There is
no `entry.embeds` field. No author-supplied HTML, sandbox flags, permission
flags or scripts are accepted. `![]()` still means a locally stored image;
embed URLs never enter image localisation or `media.store`. Ordinary links
never become players.

The source list and Markdown body are ordinary versioned content fields:
creating, updating, removing,
rolling back or restoring a source never bypasses passkey approval. Only
the approved live `site` item grants frame authority. Saving a URL never
adds its source to the list. A source and its first entry may be included
in one approval, which names both item versions; until the source is live,
its URLs are ordinary links. A missing source list means `[]`. Invalid
source values are refused as `invalid`, with the existing field problem shape. Duplicate origins after canonicalisation are refused.

**Origins and URLs.** Parse URLs structurally, never by string prefix. An
origin has scheme `https`, a lowercased ASCII/punycode host and an optional
non-default port; port 443 and an empty/root path disappear. Source input
may have no path except `/`, and no query, fragment or user information.
Reject whitespace, controls, backslashes, wildcards, trailing-dot hosts,
fullwidth/ideographic dot variants, invalid ports and malformed addresses.
Content URLs may have paths, queries and fragments, but have the same
scheme, host, user-information and control-character checks. Preserve
otherwise valid generic paths and parameters; escape them as attributes.

Both editions use the [WHATWG URL host parser and origin serializer](https://url.spec.whatwg.org/#concept-host-parser),
with the stricter rejections above. Require an explicit `https://` scheme
(case-insensitive) and no base URL. Check both raw and percent-decoded
authority before normalisation, including empty user-information syntax
and encoded forbidden host characters. Both editions use the same
international-domain mapping and canonical IPv4/IPv6 spelling. Browser-equivalent alternate IPv4 spellings must not
bypass address checks. Reject localhost and its subdomains, all non-public
IP literals (including mapped IPv4). At approval time, reject any proposed
source equal to that approval request's origin. At render time, a source
equal to the current request origin always becomes a link, never a frame.
No deployment-origin inventory is required. Another alias of this same
installation is a different origin and may be approved: this is an accepted
residual, and the browser still enforces the cross-origin sandbox. Validation
and rendering do not resolve or fetch the source URL.
DNS names are not a server-side DNS or redirect-fetch service.

Known share links are normalised before their effective source is checked:

- Exact YouTube hosts `youtube.com`, `www.youtube.com`, `m.youtube.com`,
  `youtu.be` and `www.youtube-nocookie.com`, on their default HTTPS port:
  recognised `/watch?v=ID`, short-link `/ID`, `/shorts/ID` and `/embed/ID`
  forms become `https://www.youtube-nocookie.com/embed/ID`. IDs are non-empty and contain
  only ASCII letters, digits, `_` and `-`, at most 128 characters. Ambiguous
  repeated ID parameters are refused. Tracking and player parameters are
  dropped by this canonical form. The source to approve is
  `https://www.youtube-nocookie.com`, not a watch-link host.
- Exact `my.matterport.com`, default HTTPS port: `/show/?m=ID` becomes
  `https://my.matterport.com/show/?m=ID`, with the same ID alphabet/bound
  and no extra parameters. The source is `https://my.matterport.com`.
- Other HTTPS URLs, including unsupported provider paths and non-default
  ports, stay generic URLs. Any eligible origin can be approved; there is
  no provider-only source list. `youtube.com.example.com` is never YouTube.

Keep the URL and title in the Markdown form, never iframe markup.
Canonicalise recognised URLs before source comparison and rendering; store
the normalised origin list independently of the Markdown body. A URL's
effective source must match an approved origin exactly: scheme, host and port.

**Public rendering.** Render each recognised standalone form in place as an
engine-made block, preserving its position between surrounding Markdown
blocks. A body containing only that form is still a body. An entry with
`external_url` keeps its existing outward-link behaviour. The engine, not a
look or content author, produces frame markup.
Look checks reject literal iframe/object/embed/frame tags, the engine's
internal placeholder, and tag names beginning with a template expression
(`<{{` or `</{{`). Attribute expressions and sections remain allowed.
The guarantee is applied to rendered output: before expanding genuine
engine blocks, neutralise every authored iframe/object/embed/frame tag,
including names assembled by a look. An opening tag with a permitted https
src/data/cite becomes a plain link; otherwise remove its tags and retain
its text. Closing tags are removed with a separating space. Engine markers
have unpredictable capabilities in a private render map; copying a static
placeholder or its attributes cannot create a frame. Capabilities are not
persisted in content; only the private render map can authorize a marker.
The final rendered page enforces the fixed frame attributes and an actual
page-wide limit of 12 frames, including repeated bodies: the first 12
eligible occurrences in document order may become frames, and every later
occurrence is a normal link. Count after the look selects the bodies it
renders, not while constructing unused view contexts.

For an approved source on a published public HTML page, produce a responsive
frame with the escaped URL and title, `loading="lazy"`, `allowfullscreen`,
`referrerpolicy="strict-origin-when-cross-origin"`, and exactly:

```
sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen; xr-spatial-tracking"
```

No other sandbox or permission tokens, `srcdoc`, data/blob URLs, inline
player scripts, postMessage listeners or remote sizing code are introduced.
The provider may load its own dependencies inside its separate frame;
source approval is not a per-subresource allowlist for that provider.
Always include a normal HTTPS link bearing the title beside the player;
it remains usable when the remote site refuses framing. An unapproved
source or a page-budget overflow produces only that link, with no frame
or automatic remote request. Escape titles and URL attributes normally.

Owner, review, preview, writing, upload, setup, login and passkey pages
never contain frames or remote-player requests: show escaped URLs and titles
as text/links. Feeds and search data do not contain executable frame HTML.
The local `site_check` renderer also uses links and never fetches a player.
Bodies without the standalone form keep their previous rendered bytes.

**Check notes.** Default `site_check()` scans the proposed public entries'
Markdown for recognised forms without loading a look, rendering pages or
fetching URLs. If any effective source is absent from the LIVE list (or is
the check request's own origin), append `embed_notes`, an array in entry
order then occurrence order. Each note is `{id, url, origin, note}`: the
entry id, canonical URL, canonical effective origin, and plain guidance to
ask the owner to approve that source (or use a different source for a
self-origin URL). These are notes, never `broken`, and do not change `ok`.
Keep repeated occurrences in order. Omit `embed_notes` entirely when there
are none, preserving existing no-embed answer bytes. `deep: true` retains
these same notes alongside its existing reachability fields and caps.
The proposed source list does not grant authority until approved.

**Response policy.** Follow [CSP frame-source matching](https://w3c.github.io/webappsec-csp/#directive-frame-src)
and [Permissions Policy inheritance](https://www.w3.org/TR/permissions-policy/).
Only published public HTML may gain `frame-src`, built
from the live approved canonical origins, in deterministic order. Omit it
entirely when the list is empty; `default-src 'none'` already blocks frames.
Keep CSP in the response header only. No approved origin is added to
script, connect, image, style, font, media or object sources. Effective
`object-src` and `frame-ancestors` remain `'none'`. Public HTML also sends:

```
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), display-capture=(), publickey-credentials-get=()
```

Frame delegation is limited to the fixed `allow` list above. Owner/review
and all other owner-capability pages keep their current separate CSP and
`X-Frame-Options: DENY`; they do not inherit public `frame-src` or the public
credential policy (which would break passkey sign-in). No public lookup or
new authentication exception is added.

Compute frame authority and markup from the current live allowlist on each
public response. Removing a source is an approval: after publication every
affected stored URL becomes a link and the next response's CSP shrinks,
without republishing those entries. Never persist active iframe markup as
content. If rendered-page caching is later added, every allowlist change
must invalidate it before the changed policy is served.

**Approval text.** Every add, removal and restoration of a source, including
a whole-site revert, shows the exact canonical origin as isolated,
HTML-escaped left-to-right text. For internationalised hosts, show both
Unicode and punycode on the same line. Show the current published embed
count using it and the count in this approval's prospective public snapshot.
For each new/restored source, say plainly:

> This lets published pages show anything from ORIGIN in a frame. That site
> can play sound, use fullscreen and open separate pages; it can see that
> the visitor came from this site. You are approving the whole source,
> not one video or tour.

For removal, name the origin and say its players become normal links.
Adding or changing an entry with an embed shows its URL, title, effective
origin and whether that source is already approved, proposed in the same approval, or remains
unapproved. Review never loads the player. An approved hosting origin may
serve arbitrary paths or other people's content; whole-origin approval
and this warning are the control, not a promise about the host's contents.

**Assistant guidance.** Both editions' `item_create` and `item_update`
descriptions, and the generated field/tool contract, include this exact line:

> An embed shows a video or tour from another site on your page. Each new source needs your approval; once approved, pages can show anything from that source.

Follow that sentence with this syntax line in both tool descriptions:

> Put it on its own line in the body: !embed[Title](https://example.com/player).

Explain the effective origin when a provider URL is rewritten; propose
`site.embed_sources` explicitly and include the `site` item in the approval
when adding or removing authority. Existing approved sources need no second
source approval, while entry publication still uses the normal approval.

**Acceptance.** Paired tests cover empty
and populated source lists, standalone-form placement/literal code cases,
source caps, canonicalisation and spoof/IDN/IP
cases, immutable approval versions, live versus proposed sources, add/remove/
restore review text, fixed frame attributes, exactly/over 12 actually rendered
frames, plain-link fallbacks, unchanged owner policies and zero owner-page
players, default/deep embed notes and unchanged no-embed answers. Page/tool
parity covers all sample looks with no embeds and shared embed fixtures. Browser tests cover YouTube and Matterport, fallback links,
source removal and phone layout. Security verifies the source parser,
headers, sandbox and proposed/live separation. No hosted CPU claim follows
from these functional checks.

When a look opts in with `heading_ids: true` in its manifest, entry-body
headings receive stable ASCII-only ids as defined in TEMPLATES.md. The Listing
look also enables `body_h1_as_h2`, so body `#` headings render as `<h2>`
and its page title remains the only `<h1>`. Both flags default to off;
existing looks and stored item data are unchanged. On-site menu and button
links may include a fragment (for example `/listing/home/#video-tour`).

## 4. Assistant interface (MCP)

On a new site, if site_state lists no site item, call item_create with kind: "site" and the site fields (including theme); use item_update only after that item exists.

One MCP endpoint per site, at `/mcp`, behind OAuth 2.1 (with Client ID
Metadata Documents, and Dynamic Client Registration for older clients).
On `/mcp`, an absent `Origin` header keeps the existing behaviour. A present
header must be one HTTP(S) origin (no userinfo, path, query or fragment)
equal to this site's configured origin, or the request origin when none is
configured, following the existing `www`-to-bare redirect. Compare scheme,
case-insensitive host and effective port; default ports are equivalent.
Refuse every other origin, including `null`, empty and malformed values,
with 403. This is an Origin check, not authentication: the existing bearer
token and Host checks still apply. OAuth endpoints, including `/authorize`
and `/oauth/*`, keep their existing behaviour.

If a consent-binding cookie is missing, a valid owner session may supply the browser binding for approval or denial while preserving handle validity, expiry and single use; an owner may answer another valid consent handle they minted, even if it is not the currently displayed page.
An assistant whose app can't add a connector with sign-in uses an
**assistant key** instead: the owner makes one on `/review/assistants`
(named for the assistant, shown once, stored only as its SHA-256, working
for 90 days or until revoked there) and puts it in the assistant's secret
field; sent as `Authorization: Bearer psk_…`, it reaches the same tools,
with the same limits, as a connected assistant. `/mcp` answers a POST
as JSON when the client accepts only `application/json`, and may answer
as an event stream when it also accepts `text/event-stream`. Every app uses PKCE with S256, confidential ones too. A metadata document
is kept as long as its `Cache-Control` allows, at most a week. A refresh
token is replaced at each use, and the one just used stays good beside its
replacement, so a refresh whose answer was lost can be retried.

| Tool | Does |
|---|---|
| `site_state(full?, ids?, guide?)` | By default, every item summarized as `{id, kind, title, state, version}`; `full: true` returns the complete existing item shape, including data and approval metadata; `ids: [...]` returns full items only for those ids. The `release` running and `update` (below), and all other top-level fields, are unchanged unless fixed-guide reuse is explicitly requested (SP-S3 below) |
| `item_create(kind, data, idempotency_key)` | New item (S4) |
| `item_update(id, version, data)` | Change fields (S3) |
| `item_remove(id, version)` | Remove (recoverable, S5) |
| `item_history(id)` | Every version, who made it, why |
| `item_rollback(id, to_version, version)` | Stage an earlier version as a new one |
| `approval_request(ids, note)` | Ask the owner; returns a review link (S1, S2) |
| `approval_status(approval_id?)` | `pending` / `published` / `changes_requested` (with the owner's note) / `denied` / `superseded` |
| `image_add(data?, images?)` | Exactly one of `data` (one base64 picture, existing response) or `images` (1–8 base64 pictures). JPEG, PNG or WebP, at most 8 MiB each and 8 MiB decoded in total. Sniff every file and store all or none by content hash. `images` returns `{images: [{image, width, height}, ...], next}` in input order; duplicates repeat in the answer but are stored once. Private until a published item uses it (S7) |
| `site_check` | Check the proposed site before asking for approval. With no arguments (or `deep: false`), returns only `ok`, `broken` (declared internal links to no page, populated home-page section or stored picture, each with where and why), and `empty_sections`; `ok` is true when `broken` is empty. This quick check does not render pages. `deep: true` also crawls rendered links from home and returns `unreachable`, entries with no path, each `{id, why}`, plus `crawl` if a limit stops it. Deep `ok` requires a completed crawl and empty `broken` and `unreachable`. Read-only. Run deep once before approval on a new site or look change; it is heavy and can exceed Cloudflare Free CPU limits on big sites |
| `site_stats(days?, content_id?, src?, post?, include_test?)` | Visitor numbers (§8), read-only |
| `theme_list` | The site's look: current, installed, the catalog (each credited look with its maker's `author_x`), this site's theme requests and shared looks (each shared look's status, the curator's note, and `credit`: waiting, credited or not credited, when it claimed credit) |
| `theme_submit(name, note, author_x?)` | Share a look this site made with the review queue, only with the person's yes. `author_x`: the maker's X handle (no @), the only credit there is; the answer's `credit` carries a one-time claim code and the words to post on X from that account (TEMPLATES §3c) |

`theme_list` keeps its existing fields and adds `next`: "Looks marked built-in are ready to use: set the site theme, then run theme_needs. Use theme_install only for a catalog look missing from installed or to update one."
Its `installed` list includes bundled looks with `source: built-in`, ready
to use without downloading. `theme_install` remains available for catalog
looks missing from that list or for updates.

`image_add` keeps the single-picture `data` argument and its existing
`{image, width, height, next}` response. `images` is a separate optional
array, so neither tool argument needs a string-or-array schema. Both or
neither argument, empty arrays, more than eight files, malformed base64,
non-images and size-limit violations are refused without storing any file.
Accept standard or URL-safe base64, with optional padding, whitespace or a
data-URL prefix; its MIME label and any filename never determine the type
or name. Before decoding any file, calculate every file's decoded length
from base64 and refuse over-limit calls. Then validate and sniff all files
before writing any. Commit all images in one database transaction (server)
or one atomic D1 batch (Cloudflare), including when a concurrent call stores
the same hash. A failure never deletes an existing image. Pixel dimensions
come from headers; images are never rasterized here. The one-shot
`photo_upload_link` remains a single-file upload. The server edition
accepts MCP request bodies up to 16 MiB, enough for the base64 batch and
its JSON envelope; larger transport bodies are refused before tool execution.

When saving an item, check its local picture references together in one database
lookup. Validation order and errors stay unchanged; a hotlink stored earlier
in the same item can satisfy a later local reference.

**PERF-3: image dimensions without read-side writes.** Uploads record pixel
dimensions from the stored image headers. Re-uploading an existing image
backfills missing dimensions from those same stored bytes; this metadata change invalidates
prepared public copies atomically with the dimension update. It does not alter
image bytes, names, publication or approval. Unknown or unreadable dimensions
remain unknown. Saving a local reference alone need not backfill dimensions.

Rendering, previews and read-only image-size checks never persist dimensions
or invalidate prepared copies. A legacy image with missing dimensions may be
sized from its stored bytes in memory for that response; its metadata and
dependency validator remain unchanged. Consequently an otherwise stable public
GET or HEAD does not retry rendering merely because an image was sized. The
existing authorization and publication gates still precede any rendering or
image read. Paired tests cover upload backfill, repeated legacy GET/HEAD
with zero media/artifact writes and one view, and an empty matching 304 that
does not read image bytes. No migration or new maintenance endpoint is required.

The public dependency statement selects only the current theme's
`name`, `version` and `sha256` (including the existing legacy-name aliases),
and image dimensions actually consumed by public rendering: currently the
approved site's local hero. Both use indexed name lookups; an unused upload
or an unselected installed theme must not add dependency rows or change a
validator. Never scan the entire media library to search for references.
Other image paths and theme selection remain covered by the live row versions
and share-card references. Adding another renderer-side dimension lookup also
requires adding its exact dimension dependency to the statement. Paired tests
prove unused images/themes do not invalidate a tag, while the chosen hero's
dimensions and chosen theme's digest do.

Stored pictures carry no standard location metadata; orientation and encoded pixel data are preserved, and previously stored pictures are not rewritten. Known limit: non-standard EXIF inside a JPEG APP2 segment is retained.

Pictures should be compressed before upload by default: web size, about
2400 pixels on the long side, usually under 1 MB, as JPEG or WebP.
Originals remain allowed, but the assistant must first tell the owner plainly:
bigger files use more of the free plan's limits, make pages slower and take
more storage. Both `image_add` and `photo_upload_link` describe this rule.
For successful `image_add`, keep every response field and the existing `next`
text. If any stored picture is over 1 MiB (1,048,576 bytes) after location
metadata removal, append one newline and a plain advice line to `next`, giving each oversized picture's
size in MB (MiB, rounded to two decimal places with ties rounded up) and the
same advice for next time. Batch sizes identify the input positions; duplicate
positions are included. Smaller pictures keep the previous response unchanged.

The one-shot phone upload form defaults to re-encoding the selected picture
as JPEG at quality 0.85, with neither dimension over 2400 pixels and no
upscaling. Its unchecked "Keep the original size" checkbox explains all three
risks. Choosing it sends the original bytes. Without JavaScript, or when the
browser cannot decode, draw or encode the picture, submit the original file
as before. The page says that fallback can happen. Compression runs only in
the browser; the server keeps its existing single-file and 8 MiB limits.

`site_check({deep: true})` examines at most 200 distinct local addresses (including
redirects and missing pages) and 10,000 rendered `a[href]` or `area[href]`
elements outside inert templates. Duplicate and non-HTTP links count
against the link budget. Repeated local addresses do not count twice.
Exactly reaching a budget is allowed; needing one more address or link
stops the crawl. Both editions use the same limits and document order.
When stopped, the answer includes `crawl: {limit: "pages" | "links",
max_pages: 200, max_links: 10000, pages, links}` with the counts actually
examined. `ok` is false, and `unreachable` is empty because an incomplete
crawl cannot establish that entries have no path. Existing `broken` and
`empty_sections` checks still run. A completed crawl retains the existing
answer shape without `crawl`. These limits bound traversal, not the size
of an individual rendered page.

`site_state` summary titles use the item's `title`, a card's `name`, or a
note's `text` (empty if none). Full items retain every existing field:
id, kind, slug, version, data, deleted, created_at, updated_at, state,
live_version, pending_approval and last_approval. `ids` takes precedence
over `full`, preserves the usual item order and returns each selected item
once; an empty list returns no items. An unknown id refuses the whole call
with `no_such_item`, never a partial result. Both reads use the same
owner-authorized MCP interface as every other tool; neither exposes a
public lookup. Reads do not change item versions or publication state.

#### SP-S3: opt-in reuse of the fixed site guide

The `site_state(full?, ids?, guide?)` extension is opt-in. Without `guide`,
the existing contract above remains unchanged. This changes the
authenticated tool response only; it
adds no public endpoint, resource, browser cache or template variable.

The fixed `states`, `kinds`, `fields` and `site_defaults` blocks occupy
12,858 bytes as compact UTF-8 JSON at proposal base `a1c22ea`, before the MCP
wrapper or item data. Repeating them on every targeted item read consumes
context without conveying a new item version. Keep the current default
answer and add explicit caller-controlled reuse rather than remembering
whether a server session has already seen a guide.

**Request.** Add one optional argument:
`guide: {known_revision?: string}`. An absent `guide` preserves the exact
existing success shape, including all four fixed blocks and no new guide
metadata. `guide: {}` opts in and requests the complete guide. Within an
opted-in request, `known_revision` is an opaque ASCII token of 1 to 128
characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. A malformed value,
wrong type or unknown member of `guide` gets the existing invalid-params
refusal after authentication. A well-formed unfamiliar token is a cache
miss, never an error, path, URL or instruction to fetch anything.

Errors and refusals retain their existing envelopes and contain no guide
metadata. Every successful opted-in answer adds top-level
`guide: {revision: string, included: boolean}`:

| Request | Four fixed blocks | Guide metadata |
| --- | --- | --- |
| No `guide` argument | Present, unchanged | Absent |
| `guide: {}` | Present | Current revision, `included: true` |
| `guide: {known_revision: current}` | All four omitted | Current revision, `included: false` |
| A well-formed older or unknown revision | Present | Current revision, `included: true` |

Omission is all-or-nothing; the client supplies its locally held four
blocks only when `included` is false and the revision matches its cache.
Omitted blocks are absent keys, not empty objects or null. `items`,
`release` and `update` retain their current shape and are freshly read on
every call. Existing `ids` selection, ordering, `full` precedence, item
versions, pending approvals, and unknown-id refusal are unchanged. In
particular, a matching guide never skips an item lookup, update/rollback
check or error. An `ids: []` call is a supported cheap guide handshake.
This is a normal MCP result, not HTTP 304 or a not-modified response.

**Revision and parity.** The revision covers exactly the four fixed
blocks, including every field description, state label and model default;
`site_defaults` means model defaults, never the site's current values.
Do not include items, origin, identity, tokens, live/pending state, clock,
release id or update information. A release whose guide is unchanged may
reuse the revision; a release, upgrade or rollback with any changed guide
must return the complete current guide on a mismatching request.

Use a single generated revision contract packaged with the server and
bundled into the Worker, with no network dependency. Its format-1 token is
`ssg1-sha256-<64 lowercase hex>`. A single generator derives the digest
from UTF-8 compact JSON for `{format: 1, guide: <four blocks>}`: recursively
sort object keys by ASCII order (keys in this contract are ASCII), retain
array order, and serialize primitives with `JSON.stringify`; no whitespace,
BOM or trailing newline enters the digest. Both editions consume that
same generated token rather than implementing different serializers.
The generator's check mode must refuse a stale revision contract, and
native parity must prove both actual guide builders equal its input.
Changes to guide semantics or encoding require regeneration; an encoding
change also increments the format prefix. This is a content revision,
not a credential, approval receipt or trusted assertion by the caller.

**Client lifecycle and compatibility.** The tool description explains the
opt-in: a new conversation or empty client cache first requests `guide:
{}` (optionally with `ids: []`), retains all four blocks and the returned
revision, then supplies that revision on subsequent reads. A caller that
cannot retain those blocks uses the unchanged default. Keep the cache in
the authorized caller's context, scoped to the site origin and login
context; do not create a shared service for private tool responses. Clear
it when that context is lost. A compact answer without the matching local
guide requires a fresh `guide: {}` request before interpreting guide terms.

There is no server-side seen-guide flag, session counter, persistent row,
KV entry, cookie or identity-to-revision record. Requests on another
worker, connection, transport or edition have the same result. Authentication
and authorization run normally on every request; possession of a revision
neither grants access nor changes what item data is readable. Failed auth
must not disclose guide metadata or use a token as a lookup key. No item
or caller data enters the revision artifact, public discovery, logs or
shared caches. Writes, validation and owner approval use current engine
rules, never client-cached descriptions.

Old callers omit the argument and receive today's shape. A new caller
against an old runtime may receive its ordinary full answer without guide
metadata; use that answer and stop sending conditional guide arguments.
If the old runtime rejects the new argument, retry once without it. Do
not invent a revision from that response or infer support from a release
number. Old binaries continue on the unchanged schema: no migration,
release floor or installation change is required. The release changelog sets
`reconnect: true` so assistants rediscover the changed tool input schema and
description; no credentials are rotated. Regenerate
tool descriptions, input schemas and paired wire/contract snapshots when
implementing; only explicit opt-in responses may omit existing fields.
`TEMPLATES.md` and public rendering are unchanged.

**Required proof, both editions.** Named paired cases:
`site_state_guide_default_compat` (existing default/full/ids shapes and
bytes unchanged); `site_state_guide_conditional` (first, matching, stale,
unknown, invalid token and all-or-nothing cases);
`site_state_guide_fresh_state` (writes, approvals, removals, empty ids and
unknown ids still produce fresh data or the usual error with a matching
revision); `site_state_guide_access` (OAuth and assistant-key authorization,
invalid/revoked credentials, private sites, and no public discovery);
`site_state_guide_revision_parity` (actual four-block values, token and
compact/full responses identical, with a change to each block invalidating
the revision); and `site_state_guide_rollback` (actual previous bundle and
server, new argument ignored or refused, fallback full read, return to new
and stale revision refresh). Repeat on a fresh connection and isolated
client cache to prove no server-session dependency. Run the normal paired
contract, parity and upgrade gates. Measure full and compact responses on
the sample sites and targeted `ids` calls; report absolute bytes saved and
wrapper/token overhead rather than promising a fixed percentage or CPU
saving. The compact form must remove all four blocks, approximately the
fixed 12.9 KB here, while retaining every dynamic field.

With `deep: true`, reachability uses the selected look, including an installed or site-made look,
on the same proposed site as the other checks. Starting at `/`, follow
rendered HTML anchor links through local entry, archive and tag pages;
resolve relative addresses, same-site absolute addresses and the site's
stream redirects. An external entry is reachable when a visited page links
to its destination or its local redirect. An entry also counts as reachable
when its full, nonempty body is rendered inline on a visited page (a feature
section, for example); a title or summary alone is insufficient. Draft entries and staged removals
are absent from this proposed public view. Metadata, feeds, search indexes
and unlinked pages do not establish reachability. This is a static HTML link
check: it does not run scripts, evaluate CSS visibility or fetch any URL.

The server's MCP instructions tell the assistant the rules above in plain
words, so any assistant can use the site correctly without prior training.

### Updates

**Update policy.** A site never updates itself. Nothing downloads, installs
or applies a release on its own, ever. The owner decides when to update; the
assistant does it on their say-so, following "Updating" in the install guide
(Cloudflare edition) or "Updating the server edition" in the self-hosting
guide. Porchsite's side of the bargain: every release is built only when it
is safe to update to and roll back from (below), it is described in plain
words in the changelog, and every release's files stay downloadable at
`<HOME>/v/<release>/` for good.

**Releases.** A release id is `<UTC date YYYY.MM.DD>-<commit>` (e.g.
`2026.10.11-13513a3`) and names one commit of the repository, for both
editions. Every answer carries it in `X-Porchsite-Release`, and `site_state`
returns it as `release`. Any other value (`dev`, `test`, a local build) is
not a published release. `<HOME>/latest.json` names the newest release: its
`version`, `commit`, `files` (each with `sha256`), and from the changelog its
`changes` (plain lines), `security` (true: it fixes something an attacker
could use), `migrations` (the Cloudflare edition's migration files new in
this release), `all_migrations` (every Cloudflare migration file, in the
order to apply them, each `{name, url, sha256}`), `reconnect` (true: the
tool list changed), `changelog_url`, and `releases`, every release newest
first with the same fields. A site's D1 table `_sitekeeper_migrations`
records the files applied to it, so updating applies every file in
`all_migrations` that table lacks, in order, however many releases were
skipped; `migrations` alone is not enough for that. Every release's files
stay at `<HOME>/v/<release>/files.json`, shaped
`{"version": "<release>", "files": [{"path", "url", "bytes", "sha256"}]}`
(latest.json's `files` have the same shape).

**The compatibility rule.** Schema changes are additive only: new tables,
new indexes, new columns that are nullable or have a default. Never DROP,
RENAME, ALTER COLUMN, a NOT NULL column without a default, a new constraint
or unique index on an existing table, or a rewrite of existing rows. So the
previous release runs on the new schema, and a rollback is re-uploading the
previous release (Cloudflare) or checking it out (server) with no schema
step. Released migrations never change (append only). Enforced at release
time: `scripts/migration-check.py` and `scripts/upgrade-check.sh` (the
previous release's tests and archived bundle on the new schema).
The release also runs `scripts/runtime-smoke.py` under the coordinator's
suite lock: build the real Worker entry, boot its emitted bundle on fresh
local D1/KV and boot the server entry on a disposable local PostgreSQL.
Both must serve HTML, Markdown and the map, refuse unauthenticated MCP,
and return an empty conditional 304. A startup error or an unexpected
status fails the release; the smoke check has a 60-second budget.

**Stream-settings rollback compatibility.** The public content model has
up to 64 streams, per-stream sort and the all-stream archive, but the legacy
site JSON remains readable by the previous release. New writes store the
complete logical `streams`, `sections` and `archive` in a new dedicated
`site_stream_settings` table keyed by the exact site-item version, in the
same transaction/batch as the conditional item and revision write. It has
an approval flag defaulting to false. It is separate from `site_fields`:
older releases approve all keys in that table without knowing their meaning.
The new stream table is never read or approved by old releases. No legacy
rows are rewritten and there is no migration of existing site JSON.

For each new version, the legacy JSON in `items`, `revisions`, `live` and
approval snapshots contains the first eight streams, with `sort` removed;
`archive` is omitted. Its `sections` is the first twelve entries remaining
after dropping ids outside those eight streams; the `entries` shorthand
and cards/notes/about keep their positions. The complete configuration is
reconstructed only from the extension at that same version, never from
the newest row or another version. No extension means the legacy content
with default date sorting and archive disabled. Public reads require both
that exact live site version and its extension's approval flag; draft,
history and preview reads reconstruct that exact version without publishing
it. Malformed extension data is refused as invalid, never used unchecked.

Approval shows the complete logical configuration and its changes. Only
the current implementation may mark its exact version's extension approved,
atomically with the corresponding site publish. A stale request, refused
write, idempotent replay or old-runtime approval of a previously unseen
extension cannot publish it. Rollback, whole-site revert, export and import
use the full logical configuration, with the existing version, guard and
owner-approval rules; an imported approval flag is never authority. Extension
fields are guard-checked on every write and at publish. Trimming the legacy
projection must never trim the configuration presented for approval.

Rolling back the runtime leaves the legacy site usable, without the combined
archive or title sorting, and with at most eight configured streams. Entries
whose stream is no longer configured follow the existing first-stream
fallback, so their addresses/grouping may temporarily change. This is a
display degradation, not a new release floor or change to private mode.
New-only settings and old versions remain stored; a subsequent old-runtime
edit creates a new version with no inherited stream extension, so returning
to new code cannot silently restore settings the owner did not approve.
Explain this degradation in update/rollback documentation and the changelog.

The upgrade check must seed, approve and read a site with at least nine
streams, a section naming the ninth, title sorting and the combined archive
through both current editions. Then run the actual previous Cloudflare
bundle and server on those same databases: home, a retained stream archive,
feed, local entry and owner sign-in remain usable; legacy site JSON validates
under the old models. Prove new code reconstructs the full approved version
on return. Separately have old code approve a new-code draft site version
and edit a site; on return, neither action may activate an unseen stream
extension. Cover history, export/import and revert round trips, failed and
concurrent writes, deletion/re-creation, and approvals of older versions.

Parity adds shared fixtures for more than eight streams, explicit sections,
both sorts with tied dates/titles/creation times and non-ASCII titles,
chronological feeds, event groups, and archive date/stream/tag/intersected/
empty views. Compare full HTML, redirects, headers and errors where routed;
compare sitemap and tool answers too. Existing sites with default stream
sort and archive disabled retain their page/feed bytes, except a previously
ambiguous equal-date/equal-creation-time tie is now resolved by item id.

**Private-site rollback warning.** Older code ignores `site.private` and
exposes the published site. The compatibility rule stands; no schema trick
prevents that. The first private-capable release is the minimum for a private
site, recorded outside legacy JSON. `site_state.update.rollback` reports
that minimum and explains the exposure. The unauthenticated JSON
`GET /.well-known/porchsite-release` contains only `release` and
`private_floor` (null when public), never site content. It and a signed-in
reader's 303 from `/authorize` send `Cache-Control: private, no-store,
no-transform` whether or not the site is private.

Before upload or checkout, the documented procedure runs
`scripts/check-private-downgrade --target <release>`. It stops and warns if
private is on and the target is below the floor, OR if state/floor is missing
or unknown regardless of target. Explain that the site becomes public,
that older code does not know private mode, and to choose the minimum or a
newer release, or deliberately turn private off first. Only `--confirm`
after the owner's explicit approval may proceed; assistants must never infer
that approval. The warning still prints with confirmation. Tests prove the
default stops and explicit confirmation may proceed.

The dashboard rollback button, direct upload with the hosting API key, raw
checkout, restoring an older database and a hostile assistant holding the
hosting key can bypass the documented check and expose private content.
This accepted residual must be stated in INSTALL, self-hosting, llms.txt and
the changelog. Never claim prevention. Existing cached copies also remain.

**The daily check.** A site running a published release reads
`<HOME>/latest.json` at most once a day: a short timeout (3 s), the answer
cached (Cloudflare: KV; server: the database), a failure silent and tried
again the next day with the last answer kept. A site whose release is not a
published release id never asks. The check only informs; it never fetches
the files, applies a migration or changes the site. `site_state.update` is
`{"available": false}`, or when the running release is older than the
latest:

```json
{"available": true, "latest": "<id>", "security": <any newer release is a security release>,
 "changes": [<the lines of every newer release, newest first>],
 "migrations": [<every newer release's migration files>], "reconnect": <any newer release changed the tools>,
 "how": "<the edition's update guide>"}
```

`how` is `<HOME>/docs/install/#updating` (Cloudflare) or
`<HOME>/docs/self-hosting/#updating-the-server-edition` (server). The owner's
review pages (`/review`, `/review/<id>`) show one quiet line while an update
is available: "A newer Porchsite is available (<id>). Ask your assistant to
update it.", or, when `security` is true, a line marked "Security update:"
instead. No button: the assistant updates, when the owner says so.

## 5. Owner surface

When a rendered site page is requested with a valid owner session, the
engine inserts a fixed bottom-right `Review` link to `/review` immediately
before `</body>`, independently of the look. It has inline styling, a
44-pixel minimum tap target and readable light/dark contrast; no script.
This covers home, entries, archives, tags and not-found pages, in public
and private modes. Such responses are `private, no-store, no-transform`,
vary on Cookie, and have no validators. Visitors, readers and assistants
without an owner session receive the existing bytes and headers; the
private-site gate is unchanged.

### Approval alerts on the owner's devices

Both editions offer Web Push alerts, off by default, as an owner-only device
setting. This does not change approval or assistant authority. `/review`
shows exactly one status line, "Alerts are on for this device" or "Alerts
are off for this device", with a turn-on or turn-off button. Turning on is
an explicit owner gesture: register the site's service worker, ask the
browser for notification permission and subscribe using this site's VAPID
public key, then save the subscription through an owner-authenticated,
CSRF-protected request. Denial, an unsupported browser or a failed save
leaves the device off and explains why in plain words. Do not prompt for
permission on page load. Reconcile the displayed state with both the
browser subscription and the server's saved subscription; neither alone
means alerts are on.

`/review/alerts` lists this owner's subscribed devices, with a plain device
label, added date, last-used date (or "Not used yet") and a Remove button.
Derive labels from a small browser user-agent table (for example "iPhone
Safari", "Mac Chrome", "Android Chrome"), falling back to "Browser"; mark
the current device "(this device)". Cut labels to 80 UTF-16 units and
manifest short names to 30 UTF-16 units, dropping a split surrogate pair.
Use the site's existing date format. Turning off removes the subscription
on the server and unsubscribes this browser; removing another device stops
future sends to that subscription. A failed browser unsubscribe does not
restore a server subscription. Device labels are untrusted plain text,
never HTML. Endpoint URLs and subscription secrets are not displayed.

Only a currently signed-in owner can read alert configuration, obtain the
site's VAPID public key or change subscriptions. Proposed routes are
GET `/review/alerts`, GET `/review/alerts/key`, POST
`/review/alerts/subscribe` and POST `/review/alerts/remove`; all writes use
the existing owner CSRF and same-origin checks, including JSON requests.
Readers get the existing owner-route refusal (303 to `/`); anonymous
visitors get the existing sign-in or private blank response. Assistant
OAuth tokens and assistant keys confer no authority on these routes.
No MCP tool subscribes, removes, configures targets, sends a test push or
exposes keys. The only indirect trigger available to an assistant is a
normal approval request that has successfully committed.

Store the site's VAPID P-256 key pair once, on the first owner turn-on,
using a NEW singleton table and an atomic insert-if-absent. Concurrent
first-use operations must return the same persisted public key. Private
key material never leaves the server, appears in a tool response or enters
content/history/export JSON. Subscriptions occupy a NEW table containing
an opaque device id, owner credential association, endpoint, `p256dh` and
`auth` keys, label, created time and last-used time. Reject malformed keys
before saving; `p256dh` is a valid uncompressed P-256 point and `auth` is a
16-byte secret. Normalize endpoints to the browser `new URL(...).href` form before storage,
fingerprinting or sending. An endpoint is unique per site. An opaque device marker
only identifies a device; it never authorizes an operation. New delivery
and batching state also lives only in NEW tables. Previous releases ignore
these tables; no legacy item, revision, session or live JSON gains keys.

Subscriptions are bound to the current owner credential and epoch using
the existing captured-epoch conditional-write rule. Owner passkey removal
removes its associated subscriptions; owner recovery removes all owner
subscriptions in the same transaction as the rest of recovery. Readers
never inherit them. Recheck the subscription, credential and epoch at send
claim time: a removal or recovery committed before that claim prevents a
send. A push already handed to a browser's push service cannot be recalled;
tell the owner this limit rather than promise recall.

**When to send.** Both `approval_request` and an import becoming a request
schedule the same alert path, only after the approval request transaction
commits. A rollback, refused request, idempotent replay or direct owner
publish schedules no new alert. Sending is background work: Cloudflare
uses the request's `waitUntil`; the server uses tracked background work
that holds its own database connection only while needed. Never hold the
approval transaction open during network I/O. Scheduling, encryption,
network and database failures in this work cannot fail or delay the
already-committed approval response. Process restarts may lose a nudge;
there is no durable delivery promise or catch-up burst.
The committed approval responses (HTTP and MCP) are identical whether an alert was scheduled, sent, skipped by batching, or failed, and contain no alert or delivery fields.

For each request and subscription, claim at most one outbound attempt
atomically with a unique `(request_id, subscription_id)` delivery record.
No retry of that pair occurs after a timeout or ambiguous service answer.
For each device, a new request is suppressed if an outbound push was
claimed less than 300 seconds ago and that device has not opened the
owner's `/review` since that claim. Such requests are batched into that
nudge, not queued for another notification when the timer expires.
Opening `/review` by a signed-in owner on that device resets its batching
condition; a reader, assistant or anonymous fetch does not. A fresh request
after that opening, or at least 300 seconds after the previous claim, may
send. Serialize the delivery claim and the device's batching decision so
simultaneous requests cannot both send inside the same unopened window.
Use server time. `last-used` records a push service accepting a send,
not a claim that the owner read it. A 404 or 410 from the push service
removes that subscription; other errors leave it saved for a later,
different request. Deleted or already decided requests need no late nudge.
During a send, opportunistically prune at most 500 delivery records older
than 30 days. Requests older than 30 days are not sent, so pruning cannot
allow a repeated attempt for an old request.

The decrypted JSON payload has exactly three fields: `message`, equal to
"Your site has a change waiting for you"; `title`, the published site title
(or "Porchsite" before one exists); and `url`, the site's canonical HTTPS
origin plus `/review`. No item title, body, note, count, approval id,
preview, reader identity or other content is included. Do not derive the
origin from an untrusted forwarded host or put approval credentials in the
URL. The owner is told that the site name and fixed message may appear on
the device's lock screen. The assistant still passes the ordinary review
link even when alerts are on.

**Push transport.** Encrypt each payload as `aes128gcm` under
[RFC 8291](https://www.rfc-editor.org/rfc/rfc8291), with a fresh ephemeral
P-256 key and salt per message, and authenticate with VAPID under
[RFC 8292](https://www.rfc-editor.org/rfc/rfc8292). The VAPID signing key is
distinct from the ephemeral encryption key; its audience is the push
service's exact origin and its short-lived JWT never exceeds the standard's
24-hour expiry limit. Use platform cryptographic primitives, no handwritten
curve arithmetic or new heavy push dependency. The Cloudflare implementation
uses WebCrypto. The Python server uses the `cryptography` package, declared
as a direct dependency (already present through WebAuthn). Both editions
must pass the RFC 8291 example vectors and a cross-edition test in which
each decrypts the other's message. No Node subprocess or push package.

Endpoints must be HTTPS URLs on port 443 (implicit or explicit), without
userinfo or fragments. Validate at subscribe time and again before each
send against this fixed push-service hostname allowlist:

- Exactly `fcm.googleapis.com`.
- Exactly `updates.push.services.mozilla.com`.
- A nonempty subdomain of `push.apple.com`, ending in `.push.apple.com`
  (including `web.push.apple.com`), not the bare parent.
- A nonempty subdomain of `notify.windows.com`, ending in
  `.notify.windows.com`, not the bare parent.

Compare parsed ASCII hostnames case-insensitively, with literal dot-label
boundaries. Reject trailing dots, non-ASCII/IDN or punycode labels, escaped
host characters, backslashes and control characters rather than attempting
to repair them. IP literals, localhost, private addresses and every other
host are outside the allowlist. A substring or a suffix without its dot
boundary never matches (for example, `fcm.googleapis.com.example.net` and
`notpush.apple.com` are refused). Changing this list is a spec change.
There is no DNS-based public-IP precheck; the authority boundary is the
fixed list of trusted push services, not a resolve-then-fetch test that can
race DNS changes. Cloudflare retains `global_fetch_strictly_public` as
defence in depth. Never follow redirects (including same-host redirects),
forward owner cookies/bearer tokens, or fetch a response body. Bound each
push request to a three-second total timeout and send only the encrypted
fixed payload, VAPID authorization and required
push headers. Use a short notification TTL (300 seconds); do not send to
an endpoint removed before its delivery claim. Do not log endpoint URLs,
auth secrets, keys or payloads.

**Service worker and installation.** GET/HEAD `/sw.js` is an exact public
route in either site mode, never an open prefix. It contains only constant
notification logic, no site data, credential or subscription. It handles
push and notification clicks only: no fetch interception, offline page
cache, imported scripts or background content fetch. Validate the incoming
payload shape, display its fixed message and site title, and constrain click
navigation to this service worker's origin and exact `/review` path. Focus
a same-origin window, preferring a focused one: navigate it to `/review`
if needed, then focus the returned client. If no such window exists or
navigation/focus fails, open that URL in a new window. Never approve, submit
a form or mark a request decided. Omit notification grouping/tag fields and push
Topic/collapse identifiers: none may encode a request id, item, count or
other content. Notification icons, if used, are bundled generic icons, not
content-dependent fetches. Revocation does not remove an already displayed
notification.

GET/HEAD `/manifest.webmanifest` supplies `start_url: "/login?next=/review"`, same-origin
scope and standalone display with installable name/icons. The app id stays
`/review`; notification clicks still open `/review`. Launch through sign-in
so a private Home Screen app with no existing session can reach its passkey
button. This launch URL is the same for every manifest variant. On a public site,
name and icons come from published site settings. On a private site, an
anonymous response uses only the generic name "Porchsite" and bundled
generic icons; readers also receive this generic variant. An
owner-authenticated response uses the published name and owner-accessible
icons (generic fallbacks when absent) and is private/no-store/no-transform.
Do not make a private media file public merely to install an app. Neither manifest variant
contains page lists, entries, titles of changes or credentials. The
private-site manifest must not disclose the site's name or media
anonymously. Both new open routes, and constant icon routes if needed,
retain method checks;
unmatched paths still get the private blank. They construct no live content
view for anonymous private visitors. No additional private route opens.

The page and INSTALL, llms.txt and self-hosting guidance say: "Alerts are a
nudge, not a guarantee. Phones and browsers can delay or drop them. Your
assistant still sends you the link." On iPhone, explain that this requires
iOS 16.4 or later and a Home Screen install: "Share → Add to Home Screen →
open from the icon → turn alerts on." Unsupported contexts show these
steps without claiming that permission was granted or a subscription saved.

**Acceptance, paired in both editions.** Cover owner subscribe/remove,
permission/save failure and device-status reconciliation; CSRF, cross-origin,
reader and assistant refusals; concurrent VAPID first use; invalid keys and
endpoint allowlist boundaries, mixed case, trailing dots, IDN/punycode,
ports, userinfo, IP literals and escaped-host bypasses; redirect refusal
and timeout; exact payload fields and absence of content in grouping tags;
cross-decryption against RFC vectors; at-most-once claims and concurrent
five-minute batching, per-device review reset and clock boundary; import
and ordinary request triggers, rollback/replay suppression and successful
approval responses despite push failure. In each edition, compare committed
HTTP and MCP `approval_request` answers with subscriptions absent, present,
and with the push service failing: after normalizing only differing ids and
timestamps, their bytes must be identical and include no alert/delivery
fields. Also cover 404/410 cleanup; passkey removal,
recovery and send/remove interleavings; service-worker click confinement and
absence of fetch interception; anonymous GET/HEAD/conditional checks of
worker, manifest, icons and near-miss routes while private, with no content
or credentials; signed-in manifest cache isolation. Browser evidence must
include enable, notification click, disable and device removal. A real
owner/Hand iPhone Home Screen test is a separate release gate; emulator or
desktop results must not be labelled as that test. Existing parity and
private-site contract matrices remain required.

- `/review`: what's waiting, each item previewed as the site will show it,
  Approve / Request changes / Deny per item. A decision that takes a
  moment says so as soon as it's pressed ("Publishing 30 changes… This can
  take a few seconds") and can't be sent twice; the same goes for a revert.
  Above it, when any item has a
  change no open request covers (not live, not waiting; unfinished entry
  drafts aside), one quiet line says how many: "There are N changes not
  yet sent to you for review. Nothing goes live until you approve it." Approving publishes at once.
  An item already live opens on "What changed": only the fields that
  differ, old → new (a word diff for long text, thumbnails for pictures,
  added and removed entries for lists), with a count of the unchanged
  ones; a new item shows all it says; a removal says it will be taken off.
  The confirm step of a revert shows the same rows.
- `/review/import`: content from an assistant that can't reach the site,
  as one JSON file the owner uploads: `{"porchsite_import": 1, "from",
  "note", "items": [{"kind", "data"}], "images": {"<name>": "<base64>"}}`
  (up to 25 MB and 200 items). A data string `image:<name>` (alone or in
  Markdown) becomes that image's `/media` path; a site item changes only
  the fields it names. Every item is checked as a draft would be, before
  any is saved (a failure lists each item's problem and saves nothing);
  then they become one approval request from `assistant:<from>`.
- **Share cards.** A published entry's share picture (`og:image`) is its
  share card when it has one for its current version: its photo (the
  cover, else the site's share image or hero) filling 1200 x 630, with its
  title over the bottom in large type and the stream's name and the site's
  address above it. The owner's browser draws them: owner pages fetch
  `GET /review/cards.json` (published entries whose card is missing or
  older than the entry) and send each card back as a JPEG to
  `POST /review/cards/<id>?version=<n>` (owner only, with the page's CSRF
  token; exactly 1200 x 630, at most 800 KB). A card is public once its
  entry is. The site itself does no image work.
- `/review/history`: every publish, newest first (when, who, what went live
  or came off, and the owner's note). "Put the site back to this", after a
  confirm step, restores every item to its version at that publish: each
  item that differs gets a new version with its content from then (or is
  taken off; the site's own text never is: a publish from before it was
  first published leaves it as it is), and they go live together as a new publish by the owner,
  recorded with "Put the site back to publish N" and the owner's note.
  Drafts on those items are set aside (still in their history); a pending
  request for them is superseded. A revert is itself revertible.
- `/review/write`: the owner's writing desk. Every entry, newest first, with
  where it stands (draft, ready but not live, live, live and edited since);
  the assistant's drafts appear here to finish. The owner writes or edits an
  entry (stream, title, summary, date, tags, cover, text), previews its page,
  and publishes it directly: the owner is the approver, so there is no
  approval request. Writes go through the same content rules as the
  assistant's (actor `owner`); publishing marks the entry ready and makes
  exactly that version live, nothing else; a pending request for that very
  version is marked published.
- `/review/stats`: who reads the site (§8): today, 7, 30 or 90 days.
- `/review/assistants`: connected assistants, with revoke.
- First run: the owner creates their passkey at `/setup` with a setup code.
  Without one, nobody can claim a fresh site. A setup code is either the
  one given at deploy time (`SETUP_CODE`) or a one-time code stored in the
  database, only as its sha256 hash, with an expiry (24 hours unless the
  issuer says otherwise); issuing a stored code replaces any earlier stored
  one, and the deploy-time code keeps working beside it. Whoever installs
  the site sends the owner a link, `/setup?code=<code>`: the page fills the
  code in, so the owner only adds a name and creates a passkey; no terminal.
  `/setup` answers with `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`, and its script takes the code out of the
  address bar. A wrong code is refused (`403 bad_code`), an expired or
  replaced stored one too (`403 code_expired`, also when it stops working
  between starting and finishing the claim), and with no code at all the
  claim answers `503 no_setup_code`. Claiming the site deletes every stored
  code and ends the deploy-time one: from then on every claim answers
  `409 claimed`, no code can be issued, and `/setup` (with or without a
  code) answers `303` to `/login`.

## 6. Templates

A template is presentation only:

- Layout files in **Mustache** (logic-less; mature libraries in both
  JavaScript and Python, so one template renders the same in every edition), one stylesheet, optional
  fonts and images, and a `template.json` manifest (name, licence,
  preview images, which kinds it supports; credit is an X handle only,
  TEMPLATES §3c).
- **No JavaScript** except vetted components the kit provides.
- **No fixed words.** Every user-facing string comes from the `site` item or
  from content. A test fails any template containing literal copy beyond a
  short allowlist (e.g. "Back to top" is provided by the kit, translatable).
- Must render every supported kind with sample content, work at 320 px
  wide, meet basic contrast and alt-text checks, and stay under a size limit.

Switching templates is an ordinary change the owner approves.

**HEAD.** Every address the site answers GET on answers HEAD the same way:
the GET's status and headers, no body. That covers pages, feeds, static
files, media and the 404 page (404 for both).

## 7. Conformance tests

A suite pointed at a running site's `/mcp` with an assistant token. It tries
everything an assistant must not be able to do and checks each refusal:
publish directly, update with a stale version, replay a create, approve its
own request, edit after requesting, write guarded content, hotlink an image,
and read a draft from the public site. Passing it is what lets a site call
itself Sitekeeper-safe.

## 8. Analytics

First-party and privacy-preserving; nothing identifies a person. The site
kit's beacon (`/static/a.js`, every look) posts each page view, then
heartbeats, to the same site's `POST /collect` (always 204). PERF-1's fixed
anonymous 404 documents contain no beacon. Send the page
view immediately. Keep engagement ticks and scroll measurements in the browser;
coalesce cumulative heartbeats into one at 30 seconds, then one every 60
seconds. Flush on visibility-hidden and pagehide, suppressing unchanged
snapshots. A valid heartbeat for a known view stays accepted even when it
makes no progress, but only increasing bounded engagement or scroll writes
a row. Apply those maxima atomically so duplicate, out-of-order and
concurrent heartbeats cannot lower recorded values. Keep the current input,
wall-time, four-hour engagement and six-hour heartbeat limits unchanged.
There is no visitor sampling or change to report calculations. The owner
stats page and `site_stats` report notes
say: "Time on page and scroll can lag up to a minute while someone is still
reading." If a final beacon is lost, recorded time and scroll may be lower.
The minute is a target sending cadence, not a delivery guarantee: browser
throttling or a failed connection can delay or lose a message.

Collection and counting rules:

- **Visitors.** A visitor is the first 32 hex digits of sha256(day's salt +
  address + "\n" + user agent). The salt is random, belongs to one day (on
  the site's clock) and is deleted once the day is over, so the same reader
  on two days is two visitors and yesterday's hashes can't be recomputed.
  The address is never stored. Page views are kept 90 days; as a day's
  views are deleted, its counts (visits, views, engaged time; test runs
  aside) are kept, one row per day.
- **Not counted:** the owner (signing in, and every owner page, sets the
  not-tracked cookie `sk_nt` on `/collect`; any device can opt out with
  `?sk_notrack=1`), bots by user agent, owner and protocol paths, and
  anything that never ran the script. Test visits (`?sk_verify=1`, automated
  browsers) are kept but marked, and count only when asked for.
- **Engaged time** counts only while the page is visible and the reader was
  active in the last 30 seconds, never more than the time since the view
  began (plus 5 s); scroll depth is 25/50/75/100%.
- **Counting:** a visit is one visitor on one day. Bounce: under 10 s engaged
  in the whole visit, or one page with no scroll past 25%. Sources: direct,
  search, X, other sites, inside the site; tagged links (`?src=<where>&p=
  <post>`, taken out of the address bar) are counted per tag. Shares are to
  one decimal, halves up; medians are the middle value (the mean of the two
  middle ones).

The owner's `/review/stats` and the `site_stats` tool show the same report:
totals (visits, views, engaged time, typical visit, bounce rate, share that
read more than one page), by day, per page (readers, typical and mean
engaged time, how far down they read, landings, bounce rate, exits),
sources, referring domains and tagged links, and, for the whole site,
"Earlier, counts only": the kept days' visits and views by month, newest
first.

## 9. Edition extras

Not part of the contract; one edition has them for how it is run.

- **Cloudflare edition: upload preparation.** Ordinary base64 uploads use
  length and padding for the size preflight, the native decoder for validation,
  and compiled type checks on the ordinary MCP path. Unusual encodings and
  failures retain the existing validation and refusal behavior. Limits, image
  bytes, response shapes and atomic storage are unchanged. Local-only profiling
  may observe phase names and timings; it exposes no request data or HTTP field.
- **Cloudflare edition: immutable preparation caches.** Tool input schemas
  and their JSON representations, built-in template parses, and date formatters with fixed options,
  may be reused between requests. Authentication, request context, item
  data and time-dependent rendered values are evaluated per request. Cache
  reuse never changes tool answers, schema metadata or rendered bytes.

- **Server edition: `/health`.** `GET` answers `200` with
  `{"status": "ok", "database": "ok", "release": "<release>"}` when the
  database answers, `503` otherwise; never cached. For the container's
  health check and uptime monitors.
- **Server edition: addresses from an older engine.** Only a site moved
  over from an older engine has them. A
  stored image's old address, `/media/<20 hex>.<ext>`, answers `301` to
  `/media/<name>` when exactly one stored image's name starts with those 20
  hex digits and has that extension; a file the older engine served from
  `/static/` that the site text pointed at is stored as an image by the
  move, and its old path answers `301` to it. Either answers only while the
  image is published (S1); otherwise the 404 page.

- **Server edition: `setup-link`.** `python -m server.app.cli setup-link
  [--hours N]` stores a fresh one-time setup code (§5) and prints
  `<PORCHSITE_SITE_URL>/setup?code=<code>`, so a new link needs no settings
  change or restart. Once the site is claimed it refuses and exits 1. The
  Cloudflare edition has no admin command: its installer sends the link
  with the `SETUP_CODE` secret, or stores a code in `setup_codes` itself.

## 10. Agent-friendly public sites (proposed; implementation pending)

This section specifies AF-2 through AF-8 for both editions. It changes no
access rights, assistant tools or approval authority. Agent versions follow
from the same single owner approval as the visible page. Private-site agent
access and owner-review Markdown are deferred to a separate specification.
Owner-facing claims are limited to cheaper and easier reading; no traffic,
ranking or citation improvement is promised.

### Access and cache boundary (before representation selection)

The live approved private flag is checked before resolving an alternate,
constructing a view, comparing a validator, looking up a prepared response
or following a redirect. No user-agent string, Accept value, conditional
header, query parameter or extension grants access. A bearer token is not
an AF credential; only a currently valid published-read AG Bearer under
§11 grants the limited private published-read authority specified there.

On a private site all new AF endpoints, including `/index.md`, entry,
archive and tag `index.md` paths and `/llms.txt`, return the exact blank
404 specified in §3 unless §11 authorizes the request with a valid AG
Bearer or valid owner/reader session. That exception grants published
Markdown/map copies and reader-view HTML only; AG-6 separately permits
owner-session review negotiation. Anonymous, expired, revoked, malformed
and unknown credentials keep the exact denial. A request selecting
Markdown at an existing page URL follows the same gate and exception. HEAD has the same status and security headers with no body. Public anonymous AF remains
unchanged. Denials carry no ETag, Last-Modified, Link, Content-Location, canonical URL, site name, Location,
Age, Vary or content-specific header. If-None-Match, If-Modified-Since,
If-Match and If-Unmodified-Since never change this to 304 or 412.
Private robots retains its exact existing disallow-all response. Existing
signed-in HTML behavior stays as specified in §3 and §5: private, no-store,
no-transform, no validators, and no new agent discovery or structured data.

On a public site public representations contain only approved material
visible to an anonymous visitor. Owner navigation is confined to owner
HTML. Requests carrying an owner or reader session cookie or Authorization header
bypass shared response storage and conditional 304 handling; their response
is private, no-store, no-transform, with no validators. An invalid owner
cookie does not authorize anything. Private and personalized response bytes,
validators and derived artifacts never enter a shared store.

### AF-1 / use case 9: traffic counts by agent kind

Both editions count engine-observed requests for public HTML, Markdown,
robots, feeds, sitemap and llms.txt, including only successful GET 200 responses, by site-local calendar day and one of four kinds: search
crawler, training crawler, agent acting for a person, or other. Use one
shared, versioned user-agent classification table, evaluated in memory:
OAI-SearchBot, Claude-SearchBot and Googlebot are search; GPTBot and
ClaudeBot are training; ChatGPT-User and Claude-User are user-triggered.
Unknown or ambiguous user-agent strings are other. Google-Extended is a
robots preference token, not a separately identifiable request agent. The
shared table is `server/server/app/agent-traffic.json` (version 1), bundled
into the Worker and packaged with the server. Stored kind identifiers are
`search`, `training`, `user`, `other`, in that report order. Match complete
ASCII product tokens case-insensitively, not substrings; recognized names
from multiple kinds are ambiguous and count as other. Empty, unknown or
over-4096-character declarations also count as other.
Classification is an estimate from a declared name, not verified identity;
do not add IP verification or fetch provider data. Neither edition depends
on Cloudflare analytics. Requests answered wholly outside the engine may
be absent; report this coverage limit, not a claimed total of all visitors.
Private sites, authenticated requests, owner/protocol/capability paths and
failed/missing public resources do not contribute. Check access before
counting; private denials never create a traffic row.

Store counts and dates only: no IP, raw user-agent, visitor identifier,
path, referrer, token, event timestamp, request id or per-request/per-visitor
row. Existing pageviews require visitor-level fields and analytics_daily
has only legacy visit/view/engagement columns, so neither can represent
these counts without changing existing storage semantics. Add a NEW
`agent_traffic_daily` table with `day`, `kind`, `requests` and composite
primary key `(day, kind)`; kind has only the four classes above, count is
nonnegative, and flushed increments are atomic. Counts are buffered in
process memory by day and kind only, flushed in one bounded UPSERT at most
once per minute in background work. Process loss can lose unflushed counts;
failed flushes retain bounded totals for retry. HEAD and 304 neither count
nor flush. Reports disclose delayed visibility and possible loss. No new columns or values enter
legacy analytics tables or stored content JSON. A previous runtime ignores
the additive table and keeps its original statistics behavior.

Show day, kind and request count to the owner on request through the
existing protected statistics surfaces, with the coverage/classification
limits above. Counts are request counts, not unique people or verified
agents. Reports use the existing statistics date range, include daily rows
and all four kind totals, and are site-wide even when legacy content or
campaign filters are requested: no path or campaign was stored to filter.
State this scope explicitly. Counter failures must not change delivery of a
public response; include failed increments in the coverage limitation.
Show no advice, ranking inference or automatic prompt. Public
pages, Markdown, JSON-LD and llms.txt never expose these counts.
Required paired cases are `af_agent_kind_daily_counts` (each class, other,
exclusion of HEAD/304, concurrent buffered increments, flush failure and date rollover),
`af_agent_kind_no_identifiers` (schema and writes contain only aggregates),
`af_agent_kind_owner_only` (authorized report, no public/private-denial
leak), and `af_agent_kind_parity_rollback` (same classification/report in
both editions; previous-release tests pass on the additive schema).

#### MD-1: tables in the light Markdown copy

The copy continues to derive only from the rendered approved visitor HTML,
never raw item bodies. A visible simple table with one all-`th` header row,
rectangular visible data rows, no spans or nested tables, and at most the
renderer limits becomes a GFM pipe table with a delimiter row. Preserve
header/data order and explicit left/center/right alignment. A caption, if
present, stays before it. A hidden row or cell contributes no text.
Non-rectangular, spanned, nested or block-content authored tables keep the
existing mechanical text fallback; do not invent a header or discard
visible cells to force them into a pipe table.

Cells retain escaped visible text, emphasis, safe links and image alt
references. Escape literal pipe separators, encode a literal pipe in a
link/image URL as `%7C`, and flatten a cell's line breaks to spaces so one
row stays on one line. A code span containing pipes is split into code
spans around escaped plain pipe characters: its visible code text,
including literal backslashes and backticks, must survive a Markdown
round trip. Never double-escape an already escaped text pipe. Ordinary
code outside a table is unchanged. Generated raw HTML, executable markup,
owner navigation, private/draft data and agent instructions remain absent.

Required paired cases are `md_pipe_tables` (shared exact-HTML examples),
`md_pipe_table_bounds` (64-column and shared 4,096-cell limits),
`af_pipe_table_roundtrip` (header/body structure, code/pipe/backslash/link
text, alignment and literal HTML through the copy), and
`af_pipe_table_access` (published-only, private blank gate, owner isolation,
GET/HEAD/304 and direct/negotiated copy identity). Test inline text and code
with an independent parser as well as cross-edition parity. Prepared
public copies follow the existing release/dependency identity and access
checks: new rendering must not reuse a previous engine's prepared bytes.
No new item field, schema, tool, auth path or release floor is needed.
Rolling back renders pipe syntax as the previous dialect's ordinary text.

### AF-2: validators and conditional reads

Successful anonymous GET and HEAD for home, on-site entries, stream
archives, tags, feeds, `/sitemap.xml` and public `/robots.txt` carry an ETag. This also applies
to the new successful Markdown and llms.txt responses. Missing resources,
redirects, errors, sign-in, review and capability URLs gain no AF validator.

For public text representations, the ETag is `W/"dep1-<64 lowercase hex>"`.
Compute SHA-256 over canonical JSON of the current render-dependency document,
engine release, canonical origin/path and normalized archive query, selected
Content-Type, approved training signal and the renderer-proven temporal state
defined by AF-7L below. The deployed PERF-1 minute token remains in force
until that proposal is implemented. No body is rendered or hashed for a matching conditional read. One
current-data statement must prove that the requested canonical path is still
a public resource before any 304, including `*`. A maximum version plus count
is insufficient: include all live identities and versions. Theme identity
is name, version and sha256, never the package blob. Missing paths use these
facts without liveView; existing legacy redirects retain their normal
bounded address lookup and never become conditional successes.

Direct and negotiated Markdown use the same canonical HTML URL and type,
so their validators agree. HTML and Markdown have different types and tags.
Both editions canonicalize keys, row order and timestamp strings identically.
A body change must imply a changed dependency or temporal state; conservatively
changing a validator without a body change is allowed. No pending body,
credential or session value enters a public validator. This algorithm also
applies to prepared public text copies; PUBLIC_ARTIFACTS does not select a
second text validator algorithm. Binary media retains its separately
specified SHA-256 body validator and private validators are unchanged.

Select the representation and check access first. Then implement
If-None-Match using the weak comparison and field grammar in
[RFC 9110 §13.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2):
a matching tag (including a weak or strong spelling in a list), or `*`
for an existing successful representation, yields 304 for GET/HEAD.
Otherwise send the ordinary response. A malformed field is ignored;
matching is not substring matching. If-None-Match takes precedence over
If-Modified-Since. This feature emits no Last-Modified and makes no new
If-Modified-Since promise.

A 304 has no body and preserves the selected GET's ETag, Cache-Control,
Vary and discovery Link headers. HEAD returns the corresponding GET status
and headers with no body, including the same conditional decision. A 304
never supplies a nonzero Content-Length. No conditional response turns a
missing page into a success or discloses private existence.

These anonymous public representations use `Cache-Control: public,
no-cache, must-revalidate, no-transform`. This supersedes the feed and
sitemap freshness lifetime, requiring revalidation before reuse; there is
no stale-while-revalidate or stale-if-error. Page variants merge `Accept`
into Vary rather than replacing existing tokens. Existing long-lived
fingerprinted static assets are outside this change. Deployment guidance
must disable host HTML-to-Markdown conversion and prevent proxies from
reusing stale pages or overriding the origin's access and cache rules.

### AF-3: Markdown copies and discovery

Every canonical public HTML page that returns 200 has one Markdown copy:
`/` maps to `/index.md`; `/notes/` maps to `/notes/index.md`;
`/notes/example/` maps to `/notes/example/index.md`; a tag archive follows
the same rule. Only a real page can have a copy. Unknown pages, nested
`index.md/index.md`, arbitrary file suffixes and reserved owner/protocol/
capability paths get an ordinary real 404, never a home-page fallback.
An external entry remains a redirect at its existing HTML URL and has no
local Markdown twin; discovery links directly to its existing destination.
No new redirect is resolved before the private-site gate.

A direct copy returns `Content-Type: text/markdown; charset=utf-8` with
`X-Content-Type-Options: nosniff`. It is data, never HTML. Each public HTML
page advertises its existing copy through an engine-inserted
`<link rel="alternate" type="text/markdown" href="<copy path>">`
and `Link: </notes/example/index.md>; rel="alternate"; type="text/markdown"`
for the example entry above. The copy path is generated from the canonical
same-site path, not owner text. Looks do not invent or override these links.

The combined `/archive/` page and `/archive/index.md` preserve the same
validated stream, tag and ordering filters in the projected content,
canonical URL and alternate links. Invalid or duplicate filters keep the
existing 400, without AF validators. Disabling the archive removes its
copy and map entry; a previous validator cannot produce 304 for a miss.

At a canonical HTML page URL, an explicit acceptable `text/markdown`
media range selects Markdown when its effective quality is positive and
at least that of HTML. Match media types and parameter names without case,
apply specific ranges before wildcards and honor q=0 exclusions as in
[RFC 9110 §12.5.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.1).
Absent Accept, `*/*` alone, or a strictly preferred HTML range selects HTML.
An invalid Accept is treated as absent. If neither format is acceptable,
return 406 without discovery, validators or cached content. Wildcards never
select Markdown: an HTML q=0 exclusion without an acceptable explicit
Markdown selection also returns 406. Negotiate only
existing successful HTML pages: an anonymous public miss remains the
fixed HTML 404 from the current dependency facts even when Accept prefers Markdown. Direct
`index.md` paths select Markdown independently of Accept. Both negotiated
HTML and Markdown, including 304 and 406, carry `Vary: Accept`.

Copies describe what the selected page actually shows, in its displayed
order: title, canonical HTML URL, visible summary/about/body text, visible
entry dates and tags, and visible card/note or archive entries. Omit fields
and items the look does not display. Preserve ordinary Markdown structure
and approved text; omit menus, theme chrome, analytics, scripts, styles,
owner controls, hidden fields and template source. Image descriptions and
links use their displayed alt/title and approved destination. Private cards contribute no name, description, link,
image or badge; mention cards contribute only name and description, never
a link, link label or picture. Embeds become
ordinary title-and-URL links; never fetch an embed, remote image or linked
page to build a copy. No LLM, summarizer or external conversion service runs.

Generated titles, labels and summaries are escaped as Markdown data:
owner strings cannot open a metadata/header block, inject an extra map
entry or become an HTTP header. Relative content links resolve using the
canonical HTML page, including when fetched through its deeper copy path.
Generated internal links have canonical existing destinations. Use UTF-8,
LF line endings and a final newline. Decide boundaries per parent: a
non-whitespace direct text child makes it mixed prose, whose children join
exactly as source whitespace says. Otherwise it is an element-only label
group; adjacent visible sibling elements get a single space when neither
rendered edge has whitespace. Hidden or empty children do not erase a
boundary. This applies regardless of tag, class or inherited prose context:
sibling spans spelling Work/place or wood/work become Work place or wood
work, while `Some<em>thing</em>` in mixed prose stays Something. No runtime CSS
lookup or fetch is permitted. Offline acceptance uses shipped CSS to check
all looks in both editions for glued layout labels, and independently
parsed Markdown to check that mixed prose has gained no spaces. Replay
paired native sample captures with `cloudflare/scripts/agent-layout-browser.mjs`
(the independent CommonMark helper is `server/scripts/agent-markdown-oracle.py`).
Byte parity fixtures cover
Unicode, escapes, lists, code, embeds and relative links. Canonical page
addresses and generated paths, not untrusted forwarded-host values, supply
all discovery URLs.

### AF-4: the owner's training choice

The optional boolean `site.ai_training_disabled` defaults to false.
Absent or false allows training; true disables it only with the matching
owner-approval receipt defined below. It is an
allowlisted exact-version site_fields value, never a key in legacy item,
revision or live JSON. Absence at the approved live version means training is allowed;
no older version's setting is inherited. Draft changes have no public
effect. Normal owner approval, review, restore and rollback apply; the
owner sees the setting and its effect before approving. No extra agent
approval step or service credential is introduced.

#### AF-C1: exact-version training approval receipt

Both editions add `training_approvals(version INTEGER PRIMARY KEY)` as a
new table, following the private-mode receipt pattern. Reserve Cloudflare
migration 0022 and server migration 0016, after the agent-traffic migrations
0021/0015. No existing table, column, field encoding or legacy JSON changes.
The previous released runtime must still start and operate on the new schema.

The effective published choice is disabled **only** when all four facts
hold: the live site points to version V; V has the exact
`ai_training_disabled` field with JSON boolean true; that field is approved;
and `training_approvals` contains V. A receipt for another version, another
field's approval or a draft version never qualifies. Absent/false fields
and absent receipts mean training is allowed, without inheriting any earlier
choice. Draft/revision reads retain the proposed value so review can show it;
they must never substitute that proposal for the effective published choice.
Both the live site projection and public HTTP metadata use this same rule.
The protected `site_state.training_choice` reports `proposed_disabled`
(current site item), `effective_disabled` (live site), `needs_publication`
(proposed off while effectively allowed), and a plain `note` explaining how
to activate that proposal, or an empty note otherwise. This metadata is
outside item data and is never emitted in public agent representations.

Only a successful current-code owner publication of the site may insert
its receipt. The exact version and proposed training choice must be shown
to the owner by that publication flow. The existing approval decision and
direct owner publication paths (including owner writing, restored revisions
and whole-site revert) insert an idempotent receipt for a true field in the
same atomic D1 batch or PostgreSQL transaction that advances live and marks
its fields approved. The insert checks that V is the live site version and
its true field is approved. A version mismatch, denied/deferred/superseded
item, failed validation, failed publication or rollback of that transaction
must not create a receipt or publish the setting. Publication of another
item cannot receipt the site. There is no second owner approval step.

Drafting, copying, import, restoring a draft, ordinary reads and approval
request creation never write receipts. Receipts are not imported, exported
as owner content, copied to a new version or inferred from `approved=1`.
A new version with training disabled needs its own owner publication even
when its proposed value equals the preceding version's. Existing receipts
remain immutable; only the receipt for the current live version is consulted.
Re-enabling training publishes an absent/false field at a new version and
immediately makes the prior receipt irrelevant.

Migration creates an empty table: **no backfill** from live, approval
history or approved fields. This also applies to sites used with earlier
receipt-unaware AF code. Such an existing true field without a receipt is
proposed training-off but effectively training-allowed. Protected owner
review/state must distinguish those facts and tell the owner that publishing
a fresh site version with this choice is required to activate it. An old
approval already marked decided is not silently replayed. No startup, read,
review render or migration may certify it. Apply the migration before the
new runtime starts; migration failure is an upgrade failure, never permission
to bypass receipt checking.

On rollback, a prior runtime ignores the new table. Its bulk approval may
mark the field approved, but returning to receipt-aware code must still
ignore any unreceipted version. An old runtime cannot produce a receipt;
this guarantee applies when the receipt-aware runtime is serving. It cannot
make receipt-unaware AF code enforce the new rule while that code is running.
An already receipted exact version retains its receipt across rollback and
return; an older runtime publishing a different version cannot transfer it.
Private gating and private robots bytes remain unchanged.

Robots, Content-Signal and ETag input derive from the effective choice,
never the unreceipted proposal. An old-code approval without a receipt must
not switch the signal or robots to training-off. A real current-code
approval does switch them and retags public representations as AF-2 requires.
Session no-store, private blank denials and cache revalidation rules still
apply; no receipt or approval metadata enters public bodies.

Named acceptance cases, required in both editions:

| Case | Required evidence |
| --- | --- |
| `af_training_receipt_exact_version` | True + approved + matching live receipt is off; independently missing each fact, a stale receipt, absent/false and a different live version are allowed. Draft review still shows the proposed true value. |
| `af_training_receipt_owner_publish` | Both approval paths atomically receipt the exact displayed site version; denied, deferred, stale, non-site and failed publications create none. Forced transaction/batch failure leaves no partial publication or receipt. |
| `af_training_receipt_copy_restore` | Draft/copy/import/restore and approval requests create no receipt; owner publication of the resulting version creates its own; false/removal is allowed with no inherited receipt. |
| `af_training_receipt_no_backfill` | Migration over already-approved true fields creates no receipts; effective state and owner copy distinguish proposed off from effective allowed until a fresh shown version is published. Reads and restarts do not change that. |
| `af_training_receipt_old_runtime` | Run the actual previous released runtimes on the additive schema: approve/edit a newer-code draft, then return. Bulk-approved true remains allowed without a receipt; an existing receipt survives unchanged and cannot qualify another version. Prior pages, sign-in and approval still operate. |
| `af_training_receipt_http_parity` | Identical robots, Content-Signal and AF-2 tags across editions before/after genuine receipt-bearing publication; old approval alone cannot activate off. Private denials/robots and authenticated no-store remain unchanged. |

Public `/robots.txt` starts with `User-agent: *`, `Allow: /`. When training
is off append three groups, in this order, each with `Disallow: /`:
GPTBot, ClaudeBot, Google-Extended. When on omit these denial groups.
Always finish with the existing absolute Sitemap line and final newline;
separate groups by one blank line. Search and user-triggered fetchers,
including Googlebot, OAI-SearchBot, Claude-SearchBot, ChatGPT-User and
Claude-User, remain allowed. This is a declared preference, not access
control or a guarantee about crawler compliance; private mode still wins.

Public content, copies, discovery files and their 304s also state the
origin's choice with `Content-Signal: search=yes, ai-input=yes,
ai-train=yes` or `ai-train=no`, as appropriate, on one line. This is an
explicit compatibility signal, not an adopted IETF authorization standard.
The training choice is part of the public representation metadata: changing
it must change the ETag even when visible content is unchanged. AF-2's
hash input therefore includes that exact Content-Signal value. Emit the signal only
on public responses, never private denials or private/personalized content.

The origin must state the choice itself. Install/deploy guidance and live
acceptance check the final response as well as origin output: host-managed
robots injection, automatic conversion or headers must not add a conflicting
training declaration. Disable such host features if they override the
owner's choice; no requirement depends on a paid plan or Cloudflare service.

### AF-5: structured facts in every look

Every successful anonymous public HTML page has engine-produced JSON-LD
from its actual approved visible view. The base is schema.org WebPage with
`@context: "https://schema.org"`, `@type: "WebPage"`, canonical `url`,
visible page `name` and visible `description` when present. Archive and tag
pages use CollectionPage and may list the entries visibly present there.
Every look, including installed looks, is covered; a look without specific
business facts still gets the accurate base object. Look names alone are
not evidence that a business, person, event, offer or review exists.

More specific schema.org entities may use existing fields only when their
meaning is explicit and they are actually displayed. Omit unsupported
prices, addresses, ratings, dates, identities, affiliations and claims;
never infer them from a title, arbitrary prose or a look's name. There is
no new stored listing field, remote lookup or model-generated fact.

Emit one inert `script type="application/ld+json"` data block; no executable
inline script is permitted. JSON-escape all strings and escape `<`, `>`,
`&` and U+2028/U+2029 so `</script>` in content cannot escape the data block.
Do not weaken script-src, add unsafe-inline or open network destinations.
This is a narrowly specified engine data block; the template rule against
inline executable scripts remains intact. The inline data block must work
under the current `script-src 'self'` without weakening it; a browser test
must prove this on the actual delivered page. If the inline block does not
work under that policy, both editions instead serve the same JSON-LD bytes
at `<page>/index.jsonld` (`/index.jsonld` for home), with Content-Type
`application/ld+json; charset=utf-8` and nosniff. The HTML page links that
generated same-origin twin with `<link rel="alternate"
type="application/ld+json" href="<twin path>">` and the corresponding Link
header. The twin is available only for a real public HTML page and follows
the identical gate, session/cache isolation, ETag/304 and invalidation rules
as Markdown copies; private requests return the exact blank 404 for every
cookie class. A browser test must prove discovery and fetching under the
unchanged CSP if that fallback is chosen. The implementation selects the
same strategy in both editions and records which path the paired tests
prove; it never falls back by relaxing CSP. JSON object key order and array
order are deterministic and identical in both editions. The implementation
uses the inline inert data block, with the paired browser acceptance case
`af_jsonld_visible_fields` proving its presence and parsing under the
unchanged delivered CSP; no public JSON-LD twin is introduced.

### AF-6: a short public map

Map titles and summaries fold line breaks and whitespace to one space and
escape only backslash, square brackets and angle brackets, plus a leading
Markdown block marker (heading, list, rule or code fence). Ordinary prose
punctuation and ampersands remain literal: `up to date.` and `llms.txt`
must not gain backslashes. This map-only rule preserves each
`- [title](<url>): summary` line against hostile brackets, `](`, HTML-looking
text and embedded newlines. Existing URL validation, order and size/link
limits remain unchanged; page Markdown copies retain their own escaping.

`GET /llms.txt` returns `text/markdown; charset=utf-8`, nosniff, with ETag
and conditional reads as above. It contains the visible site title, the
approved visible site description if present, and a list of canonical
Markdown copies with their visible page titles and summaries. No synthetic
summary is written when the owner supplied none. The title is one line;
descriptions and list labels are escaped data, never agent directions.

List home first, then the enabled combined `/archive/` page, then published
local entry pages in displayed stream and entry order. List only the
unfiltered archive, never one map row per filter combination. Only pages whose anonymous canonical HTML GET returns 200
may be listed. Stream archive and tag copies remain discoverable through page
links, but are not additional map entries in this version. Deduplicate paths;
include only successfully generated same-site copies. Limit the map to
16 KiB UTF-8 and 50 links, whichever comes first, cutting only at complete
lines and UTF-8 boundaries. A title or description that will not fit is
truncated as plain text. Large sites remain discoverable through their
archive copies and sitemap; an incomplete map never claims completeness.
Add `Link: </llms.txt>; rel="describedby"` to public HTML and Markdown
responses, merging it with the alternate link rather than replacing it.
No llms-full.txt, plugin instructions or new agent protocol is generated.
This file is a convenience map, with no search-ranking claim.

The map is built from one approved reader view, without rendering or routing
one HTML/Markdown copy per link. Home uses the published site `title` and
`description`; the combined archive uses its configured `title` and no
summary; local entries use their published `title` and `summary`. No tagline,
intro excerpt, title repeated as a summary, or theme-authored heading is used
as a substitute. This deliberately makes labels independent of a customized
heading and may change existing labels/summaries; URLs, order and
caps remain the same. A site with no approved site row has an empty map.
This metadata consists only of fields approved for public publication, never
private-card data, pending revisions or owner metadata. The HTML/Markdown
copies themselves retain their existing mechanical projection.

Eligibility is established from that same validated live view and the
engine's canonical route rules: home, enabled combined archive, and local
non-draft entries. It does not perform internal HTTP reachability probes.
Both ordinary and conditional map reads use a small constant number of
database calls independent of entry count. With prepared artifacts off, a
matching conditional map read uses at most three statements and no whole-live
body query; a map 200 uses at most one reader view. Neither path renders
templates/bodies, looks up media bytes or projects per-link Markdown. Compute the AF-2 dependency validator before constructing the map text; a matching GET/HEAD
returns the usual empty 304. No derived body or validator bypasses the fresh
private/publication gate, and session requests remain no-store without a
public validator. A 200-entry fixture proves the database-call ceiling for
both 200 and 304, plus unchanged private-gate behavior.

### AF-7: prepare public artifacts without weakening publication

Prepared lookup, delivery, filling and build-ahead are OFF by default.
Only the operator environment value `PUBLIC_ARTIFACTS=1` (Cloudflare) or
`PORCHSITE_PUBLIC_ARTIFACTS=1` (server), together with the pinned canonical
`SITE_URL` / `PORCHSITE_SITE_URL`, enables them. Absent, empty and every other
flag value keep ordinary live rendering. Requests, cookies, MCP arguments
and public discovery never set or expose this flag. The installer pins a
new site's known install origin without enabling prepared delivery; updates
preserve existing origin metadata. Public requests never pin an origin.
Invalidation remains mandatory and atomic even with delivery disabled.
Hosted CPU is unmeasured by local diagnostics; default enablement awaits a
separate hosted measurement and release decision.

Both editions store prepared public HTML (including its inert JSON-LD),
Markdown and `/llms.txt`, built from the anonymous approved snapshot.
This replaces repeat rendering, not the per-request access check. Nothing
private is prebuilt, and no private artifact table or agent cache is added.
The observable response contract remains AF-2..AF-6: the same bytes, tags,
canonical addresses, negotiation, discovery, CSP and cache directives.

#### Backend and scope

Use a new D1 artifact table in the Cloudflare edition and the equivalent
PostgreSQL table in the server edition. Both work with the existing install
bindings, API-uploaded bundle and self-hosted process; no paid cache product,
new service credential, queue service or domain change is required. Reserve
Cloudflare migration 0023 and server migration 0017, after training receipts.
The existing canonical-origin configuration (`SITE_URL` on the Worker,
`PORCHSITE_SITE_URL` on server) is required for cache eligibility and must
match the request origin. The new-site installer records its known origin;
updates preserve it, and requests on an unconfigured or different origin keep
today's live path. No public request pins or changes this configuration.
The tables are disposable derived data; prior releases ignore them and
continue operating on the additive schema. No existing migration is edited.

A cache outside the engine that can return a response before the private-site
gate is excluded. Workers Caching and the runtime Cache API are distinct:
Cloudflare documents the former as capable of serving without executing the
Worker, and the latter as local to the handling data center, including its
delete operation ([Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)).
Neither is an authorization source or a global invalidation guarantee.
An optional future accelerator needs the same fresh gate and snapshot checks;
it is not part of this table implementation or a reason to weaken headers.

Non-GET/HEAD methods go directly to their ordinary handler after the current
outer access gate. They never enter artifact dispatch or repeat its gate;
owner approval retains its fixed database-round-trip budget.

Eligible stored results are anonymous successful GET representations of
home, published local entries, stream archives, tag pages, the enabled
combined archive, their Markdown copies, and `/llms.txt`. Include only paths
whose ordinary anonymous HTML route succeeds, with existing filter validation
before key formation. No redirects, errors (including 400/404/406/500),
search JSON, feeds, sitemap, robots, static assets, media, collection endpoints,
protocol, owner or capability paths are stored in this version. Their existing
behavior and validators remain unchanged. Valid filtered combined archives
may fill on demand; background preparation never enumerates filter products.
Unknown or invalid query parameters retain the existing route behavior;
parameters ignored by a route cannot create extra stored variants.

Requests with Authorization or any owner/reader cookie present, including
expired or revoked cookie values, bypass artifact lookup, delivery and filling.
They use today's personalized/anonymous-projection paths and no-store policy,
except for §11's authorized private published Markdown/map revalidation;
that exception still never reads, fills or delivers an AF-7 row.
This does not bypass mandatory invalidation when an authorized mutation
changes publication, or gate-time deletion of obsolete public rows.
Other cookies do not enter a key or the anonymous renderer. Do not remove a
credential to make its incoming request cache-eligible. A separate internal
public builder takes only approved public inputs and never an owner's request.

#### Snapshot identity and row format

Every request first runs the current private-site/access gate against live
state, before stored-copy lookup, representation negotiation or builders.
Private AF paths without a valid §11 principal still return the exact
blank 404, without validators, Link, Vary, Content-Signal or Age. With a
valid §11 principal, private published copies follow its private cache
and principal-validator rules; owner review copies remain owner-only and
no-store. Private HTML, including AG Bearer reader-view HTML, is live and
no-store. No private response reads or writes an AF-7 artifact. Authorization
results, positive or negative, are never cached. Backend errors cannot turn a failed access check into public access.

For an eligible public request, obtain a consistent snapshot identity G from
authoritative database state; never trust an isolate, process or stored row's
last-seen generation as current. G covers the complete effective published
state: the ordered live item/version/address/publication-time manifest;
approved exact-version site fields, embed and stream settings and their
receipts; effective privacy and training choice; active theme name, version
and package digest; share-card mappings and public image metadata used in
HTML; configured canonical origin; and engine/render-format version.
Immutable version references can replace content bytes only where their
immutability is already enforced. Mutable rendering dependencies must be
included directly or by a digest maintained by all their write paths. Drafts,
pending approvals, reader/session records and analytics never contribute.

In particular, a generation counter bumped only by new code is insufficient:
previous runtimes can publish, change a theme or write share-card mappings
without knowing it. Fresh state observation must detect those changes after
rollback/return too. The implementation supplies shared deterministic fixtures
for G; both editions hash the same normalized dependency values. Embedded
JSON is decoded and object keys are ordered before hashing, so database JSON
whitespace and Unicode escapes do not create different G values. Snapshot
reads must be consistent across those dependencies, with a final fresh
comparison before a build is admitted. A mismatch retries from current state
or uses the ordinary safe live path; it never serves a mixed snapshot.

Keys contain configured canonical origin, G, engine/render format, normalized
page address including the validated archive filter query, representation
(HTML/Markdown/map), and the display-clock validity interval. Host and forwarded
headers, arbitrary Accept strings, cookies, user agents, tracking query values,
tokens and owner text cannot create variants. The key grammar comes from the
existing route and AF negotiation rules. Limit an encoded key to 2048 UTF-8
bytes and stored response metadata to 8 KiB; larger valid responses use the
ordinary live path without storage. G is a SHA-256 digest of the shared
normalized dependency encoding, not a database-local sequence.
Canonical and direct Markdown use the same representation body and AF-2 tag;
request-specific Vary/HEAD behavior is reconstructed on delivery.

Use new `public_artifact_state` and `public_artifacts` tables. The former is a
singleton recording the observed G and a bounded build lease; neither is an
authorization or display-clock cache. Leases coalesce one snapshot job and
expire after 30 seconds; jobs check a 250 ms wall budget and each copy's
AF-7L temporal boundary before starting that copy. An in-flight render may
finish after that budget, but cannot admit an expired copy. Later requests
safely fill unfinished work. A visitor fill recording G is not a completion
marker: it must not suppress scheduled preparation of home, archive or map.
The latter stores key, G, normalized origin/address/representation, UTF-8 body,
Content-Type, AF-2 ETag, approved Content-Signal, a fixed allowlist of public
response metadata and an exclusive `valid_until` UTC timestamp. No arbitrary
response/header serialization: never store Set-Cookie, authorization data,
Review links, CSRF, request IDs, analytics or credentials. CSP and discovery
metadata must be from the same snapshot as the body. Never persist a 304 or
an incomplete build. The internal key and G do not alter AF-2's ETag input.

For HTML and map, store the successful anonymous body after the existing
public-data projection; include the current JSON-LD and discovery markup in
HTML. Build Markdown mechanically from that same approved visitor projection.
No HTTP fetch of the site's own pages, CSS, embeds or other remote resources,
no agent execution and no new instructions are introduced by preparation.
Representation metadata and row bounds are validated on retrieval; an invalid
row is deleted and treated as a miss, never repaired by serving arbitrary
stored headers. Stored copies are never an owner-content source or import.

#### Invalidation, races and display time

All effective public changes clear the site artifact table and update its
observed G in the same D1 batch or PostgreSQL transaction as the change.
This includes publication, unpublish/removal, rollback publication, whole-site
revert, card visibility, privacy, training receipt/choice, stream/archive
settings, active theme install/update, and publication of share-card or image
metadata that changes HTML. A successful owner approval remains successful
when preparation later fails. Draft writes/imports/approval requests that do
not change the effective public snapshot do not invalidate it. This defines
"every change" as every change that can affect the public response.

A private-on transaction deletes all public artifacts; no private replacement
is built. Unpublish deletes the affected old copies before a subsequent
response; use whole-site invalidation first to avoid missing cross-page
cards, archives, map or navigation dependencies. Training changes invalidate
all formats even if body bytes are unchanged. A change that fails or rolls
back cannot leave a partly replaced artifact set. A failed mandatory delete
fails that mutation atomically; it is not a best-effort post-commit purge.

If fresh authoritative G differs from `public_artifact_state` (including after
an old runtime writes), delete old rows before any stored read and install
the observed G atomically. Previous runtimes do not serve these tables while
rolled back; they cannot be made to perform AF-7 deletion themselves. On
return, stale rows are discarded before use, including when the site is now
private. This compatibility boundary never permits serving a stale artifact
or honoring its validator. Gate-time private cleanup may delete prior public
rows but never loads their bodies or runs a builder. If that cleanup fails,
the private request still returns its exact blank denial, with no stored read.

A builder captures G, renders in memory, then atomically rechecks the current
public state and G before inserting. A concurrent publish/private-on, a time
boundary or format change discards that build. Use compare-and-insert/transaction
semantics so a late old builder cannot repopulate rows after invalidation.
After reconstructing and validating a stored response, recheck its exclusive
expiry and the authoritative snapshot immediately before delivery; otherwise
delete that key and use the live renderer. This applies to warm 200 and 304
hits as well as fills. Once a
privacy or unpublish commit has occurred, a request newly authorized after
that commit cannot serve an old body or 304. Already delivered or previously
authorized in-flight public bytes cannot be recalled, as in the existing rule.

AF-7L below replaces the blanket minute expiry and the 300-second storage
cap with a renderer-proven temporal boundary and a separate 24-hour storage
cap. Until AF-7L is implemented, the deployed minute/300-second bounds remain
the conservative behavior. No expiry rule is a substitute for the current
access, existence and dependency checks on every request.

#### AF-7L: renderer-proven public time intervals (proposal)

This is a spec proposal, not a claim about current runtime behavior. It
amends AF-2 and PERF-1's clock component, and AF-7's stored-copy lifetime, in
both editions. No code is authorized until review. PUBLIC_ARTIFACTS remains
operator opt-in and OFF by default; the validator improvement also applies
when no public copies are stored. Private principal validators, AG cursors,
approval authority, publication semantics and UC9 accounting are unchanged.

##### Proof and encoding

For one canonical path/query and selected representation, the renderer owns
a versioned temporal plan: `{kind, state, next_change}`. `kind` is `static`,
`bounded` or `unknown`; `state` is a small canonical, named projection of
clock-dependent values and visibility/order selectors; `next_change` is an
exclusive UTC instant or null. A static plan proves the representation's
bytes cannot change solely because time passes while its data dependencies
are fixed. A bounded plan proves the same until `next_change`. An unknown
plan is also required when a non-static producer has no provable finite
future boundary; null is reserved for the proven-static plan. An unknown
plan has no such proof and uses the live/no-store path without a public
ETag or stored copy. A known conservative earlier boundary is allowed; an arbitrary
minute is not proof for an unregistered clock reader.

Replace the UTC-minute hash input with `["public-time/1", kind, state]`.
Static state is the fixed empty list, with no current time, date, year,
rolling TTL or expiry bucket. Bounded state contains only registered
renderer inputs that can influence that path's representation, including
conditional branches, attributes, list membership and ordering. It is not
the full HTML/Markdown body and never includes private or pending data.
`next_change` and the administrative storage cap are not hash inputs: moving
a rebuild deadline must not churn an otherwise identical validator. Keep
the existing dep1 prefix, canonical encoding, release, origin, path/query,
Content-Type and training signal. Direct and negotiated Markdown still agree.

At every request, after the existing gate and resource-existence proof,
recompute the temporal state from current dependency facts at one pinned
request clock. Compare a supplied tag only after that computation. At or
after a prior deadline, recompute; an unchanged state may retain the same
tag, but a changed rendered byte must change data dependencies or state.
There is no session/cookie/Authorization exception to the existing bypass:
those requests never use the public shortcut or a shared copy.

Before returning a matching 304, recheck the current dependency facts and
that the pinned plan has not crossed its exclusive boundary. A boundary
crossing retries the cheap plan at the fresh clock, not the old 304. Bound
retries; repeated instability uses the safe live/no-store path. A render or
fill uses the same pinned clock as its plan and is rejected for caching if
the clock crosses its boundary before admission/delivery. Clock rollback
also invalidates a cached time interval: never assume process time is monotonic.

##### Complete renderer inventory

The inventory below follows `blocks.ts` / `server.spec.blocks`,
`theme.ts` / `server.spec.theme`, the built-in site/archive renderers,
agent-map, structured-data and discovery/feed builders at this spec's base.
All current wall-clock-dependent public producers are hours, notice expiry
and event grouping. Reading a stored date is not itself a clock dependency.

| Producer/input | State and earliest possible next visible boundary |
|---|---|
| Hours: `open_now`, status and next opening | Current open/closed status and the exact displayed next-open/until value. Weekly and exception intervals use open-inclusive, close-exclusive HH:MM comparisons. Include the next opening/closing, local date change, or timezone-offset transition that can alter these values; overlapping/split spans retain the renderer's actual first-match behavior. |
| Hours: today's row, exceptions and lookahead | Today's weekday marker; identities/order of exceptions in the inclusive local-date-to-date+60-day window; any next-opening search result over the following seven dates. Include local midnight and exception start/end and lookahead-entry boundaries, even when currently closed. These can change without an open/close transition. |
| Notice/banner | `shown` depends on nonempty text and `until >= local date`. A dated notice expires at the first valid local midnight AFTER its inclusive `until` date, not at the start of that date. Empty or undated notices are static. |
| Event `is_past`, upcoming/earlier buckets | The current helper compares the stored end (or start when end is empty) strictly less than local YYYY-MM-DDTHH:MM. Equality remains upcoming: the transition is the first displayed local minute STRICTLY AFTER that endpoint. Preserve this existing behavior; do not replace it with start/end >= comparisons. Include every visible event that could move into/out of a rendered bucket, not just today's first three or the currently visible bucket. |
| Event dates, time labels, RSVP deadlines and schedule rows | Formatting the stored start/end, date, RSVP deadline and schedule time is static. The existing zone abbreviation is calculated at the stored start date, not from the current instant. Event `status` is an approved field, not an automatic timer. Only consumers of `is_past`/bucket selectors require a clock state today. |
| Stored entry/note date; approval-based updated label | Fixed date formatting and `site.updated` from visible publication timestamps do not advance with now. No current relative-date helper or current-year footer exists. Literal “3 days ago” or a literal copyright year in approved text/template is static text. |
| Future relative dates or generated current year | A new helper must register its actual next label-change boundary: elapsed-time thresholds for duration-based labels; valid local calendar boundaries for Today/Yesterday/day labels; the declared clock's New Year for a generated year. Do not claim one midnight rule covers all relative-date functions. It is not an existing feature added by this amendment. |
| Future scheduled publish/unpublish or timed visibility | Future-dated entry metadata is NOT scheduled publication today: approved live entries already appear. Do not hide them until their date. If scheduling is later introduced, its next effective visibility/access change must be represented in current facts and evaluated before any 304 or body, including wildcard conditionals; ownership/approval may never be bypassed by the time plan. |
| Feed, robots, sitemap, map and structured metadata | Current feed timestamps come from stored entry dates (empty-feed epoch is fixed); sitemap dates come from approvals; robots from approved policy; map/JSON-LD from published fields. These have no clock component merely because the site has hours or events elsewhere. Static/unshaped 404 bodies likewise gain no clock input. |

For HTML, include time-dependent classes/attributes as well as visible text.
Mechanical Markdown copies follow the actual visitor HTML projection:
visibility/text/link changes count; an attribute the projection discards
may be excluded only with a projection proof. The combined archive's fixed
dates do not inherit a themed home page's unrelated hours/notice clock.
Resolve enabled stream/tag filters and the representation before selecting
the footprint. A different page or an invisible draft/private card must not
create a temporal dependency for this resource.

The proof is renderer-side, never an owner-provided “static” flag, a user-agent
claim, a cached successful sample, or a scan for date-looking strings. Cover
every producer that can reach the emitted response, including inactive and
inverted template sections, list selection, shared head/footer partials,
escaping/projection and any lazy body access. Merely logging fields read by
one successful render is insufficient: a presently hidden branch may later
become visible. Engine-owned template analysis may narrow a conservative
footprint; it must be bound to the selected theme digest and renderer release.
Without that proof, use all registered clock producers possibly reachable
from that route. If those producers are absent/inert, static is still
provable, including for a custom look. Unrecognized producers or unsupported
analysis yield unknown, never static. A new clock reader cannot ship without
a named dependency/boundary contract and paired tests.

##### Timezones, cheap reads and stored copies

Compute boundaries as real UTC instants by evaluating the SAME site-local
calendar and comparison rules as the renderer, using IANA timezone rules.
Never add 24 hours to mean tomorrow, or add one UTC minute to a local event
endpoint without resolving the actual wall-clock predicate. Spring gaps,
autumn folds, repeated local times, non-hour offsets and skipped dates must
include any intervening timezone transition that changes the projection.
The state can change more than once across a fold; evaluate both occurrences.
Malformed/unsupported zones or an unprovable conversion yield unknown.

The cheap facts statement may project required event endpoints/selection
metadata from visible live rows, alongside the approved site hours/notice
already in site data. It must not load entry bodies, themes.package, images,
full liveView or a stored response just to prove time. No N+1 lookups, no
clock-proof write on GET/HEAD, no materialized private state. Preserve the
three-statement and 10 ms hosted-CPU acceptance target for a stable matching
public conditional, and the one-statement unshaped miss. Do not replace the
saved render cost with repeated timezone conversion or template compilation
on every conditional hit. Temporal state and facts use identical canonical
ordering in both editions. A proof cache is only a compiler optimization;
its key includes renderer release/theme identity and it is never authority
for access, existence, current data or the request clock.

For enabled AF-7 public copies, `valid_until` is at most the earlier of
`next_change` and build-clock+24 hours; null static boundaries use the latter.
This cap bounds the reuse age of a derived copy over a daily operating cycle
while permitting sparse visits to reuse it across minutes/hours.
It is not HTTP freshness permission: public Cache-Control still requires
revalidation, and current access/G/snapshot checks still run on every hit.
Storage expiry alone does not change the dep1 tag: a static conditional may
return a cheap 304 even when its stored row has expired or is absent, without
rebuilding it. Delete/replace expired public rows only on the existing safe
maintenance/fill paths, never on the matching-304 path. No private prebuild.
No new table, trigger or migration is required by this temporal proof; a
later stored-revision optimization requires its own reviewed change.

##### Paired acceptance plan

| Case | Required proof in both editions |
|---|---|
| `af_time_static_sparse` | For every look plus built-in and a custom look with no active clock producer, home/entry/stream/tag/direct+negotiated Markdown/map retain exact bytes and dep1 across minute, hour, day and year boundaries. Warm GET/HEAD return empty 304, at most three statements and no view/parse/body hash/UC9/write. |
| `af_time_hours_boundaries` | Before/at/after open/close, split/overlapping spans, closed weeks, exceptions, date+60-day window and seven-day next-open search: state/body changes agree, otherwise tags remain stable. Include the today CSS class separately from Markdown text. |
| `af_time_notice_inclusive` | Empty/undated notice is static; dated notice remains shown throughout `until`, disappears only at next valid local date; no old-tag 304 across that visible transition. |
| `af_time_events_strict` | Event with/without end remains upcoming at exact endpoint minute, moves only when renderer's strict comparison changes; home buckets, entry, filtered archive/tag and absent buckets covered. Future-dated live entries remain visible. |
| `af_time_zone_transitions` | Paired UTC, spring gap, autumn repeated hour, non-hour transition/offset and skipped-date fixtures. Freeze just before/at/after every affected UTC instant; deadlines/state agree with independently rendered bodies, including a fold that reverses is_past/open status. |
| `af_time_projection_scope` | Map/feed/robots/sitemap/JSON-LD remain static despite unrelated active site hours/events. Test custom partials, hidden/inverted branches, attributes, projection-stripped fields and lazy body paths; no single-render tracing shortcut. |
| `af_time_unknown_and_races` | Unknown helper/zone/proof cannot authorize 304/storage; deadline crossing during render or final check discards stale work. Clock rollback recomputes. Concurrent private-on/unpublish, cookies/Authorization and wildcard conditions retain existing gate/existence isolation. |
| `af_time_complete_registry` | Maintain a paired inventory of all wall-clock reads reaching public rendering. A deliberately added unregistered reader fails the contract check; mutations omitting notice/event/hour/lookahead/DST dependencies are caught by a body-vs-state differential oracle. |
| `af_time_storage_cap` | Static/dynamic enabled prepared copies survive two-minute sparse hits until actual boundary or 24-hour cap, never after private-on/removal. Absent/expired row does not prevent static cheap 304. Old runtime writes still invalidate through current data; rollback never widens access. |
| `af_time_sparse_measurement` | On unchanged real production Worker bundle and server, issue GETs at least two minutes apart, including old tags across minute boundaries. Compare existing minute behavior to this candidate: status/body/tag, hosted CPU, D1 statements/rows read/rows written per request, render calls, artifacts OFF and separately explicitly ON. Report cold/conditional/warm separately; local CPU is not hosted evidence. |

Acceptance enumerates ALL computed boundaries in the fixture horizon,
samples interval interiors, and compares independently rendered actual
HTML/Markdown/map bytes with state transitions. It also sweeps fixed-clock
grids and timezone transitions not chosen by the candidate scheduler, so
testing only its reported deadlines cannot conceal an omitted boundary.
Do not advance production clocks or publish to real sites to create fixtures.
Hosted sparse testing uses an explicitly authorized disposable public site;
no default enablement or performance claim follows from local tests alone.

#### Build scheduling, limits and delivery

After a successful public change, prepare home HTML/Markdown, unfiltered
combined archive HTML/Markdown when enabled, `/llms.txt`, then published local
entries in displayed order, bounded to 50 pages. Share one approved snapshot
per build batch. No private prebuild, authenticated fetch or combinatorial
tag/filter walk occurs. Additional eligible pages fill on demand. A cold
request or expired row uses ordinary live rendering and may store that
successful response after the same commit checks. No queue, cron or process
lifetime is required for correctness; interrupted work is simply a miss.

Bound a body to 256 KiB UTF-8, a site's store to 128 artifacts and 4 MiB of
body bytes, and one background job to one coalesced snapshot. Oversized
results still render live; storage limits never truncate a page. Stop
preparation at the budget; evict only disposable public rows and never owner
content. Apply bounds atomically under concurrent fills. Background work is
bounded and cannot delay approval response indefinitely; if the request
lifetime cannot finish it, later public requests safely fill missing rows.
No mandatory external queue or unbounded retry is introduced.

Store hits keep `public, no-cache, must-revalidate, no-transform`; never
immutable, positive max-age, stale-while-revalidate or stale-if-error. Internal
row lifetime does not grant an external freshness lifetime. A matching valid
AF-2 tag returns today's empty 304, with the same public metadata. HEAD uses
the GET status and headers with no body, after the same access/state checks.
Direct/negotiated Markdown retain body/tag identity and existing Vary: Accept
rules; HTML versus Markdown cannot share a representation key. No stored
404 or prior tag may turn a private/missing/unpublished path into 304.

A cache miss, eviction or artifact read/write error falls back to ordinary
live rendering only after a successful current gate; it never serves stale
on error. If current authorization/state cannot be determined, follow the
existing failure/denial path with no-store and no validators, not a cached
success. Corrupt or unavailable derived storage cannot break publication or
make a private response public. Current request accounting still runs exactly
once: UC9 classifies/counts the actual anonymous public GET 200; internal
preparation creates no traffic count, page view or synthetic browser event.
Do not serialize an old analytics result into an artifact.

#### CPU measurement and acceptance

The goal metric is hosted engine CPU milliseconds per warm anonymous public
hit, before versus after, with the complete gate, snapshot validation,
conditional handling and normal UC9 accounting enabled. Measure separately
for HTML, direct and negotiated Markdown, map, and repeat conditional 304s;
include home, an entry, stream/tag archives and a filtered combined archive.
Use all 12 native sample looks for byte/parity checks and a representative
small/large synthetic published dataset for CPU. Record at least 100 warm
requests per measured scenario in three interleaved baseline/candidate
batches, versions/configuration, hit ratio, p50/p95 CPU, wall time, errors,
body bytes, database queries/rows read/written, and preparation/invalidation
CPU and writes. Separate cold fills from warm hits; report total cost at the
measured hit ratio so rebuild work is not hidden.

Cloudflare's hosted CPU metric is distinct from wall duration
([Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)).
Use the same authorized synthetic hosted test site, plan, region and request
mix for before/after; do not deploy to an owner's site or change plan to
obtain evidence without its normal deployment authorization. Match returned
bodies/tags as well as metrics. Isolate measurement traffic and retain only
aggregate timing/count evidence, not visitor identifiers or raw per-request
user agents. For server, report process CPU on the corresponding self-hosted
test setup too; local workerd timing is diagnostic, not hosted CPU evidence.
If hosted CPU cannot be collected, mark the goal unmeasured rather than
substituting latency, bytes, 304 counts or local CPU. Default enablement needs
a repeatable warm-hit CPU reduction, no unexplained p95 regression, and all
safety/parity checks; failed measurements require revision or an explicit
release decision, not a claim of improvement. No search/traffic promise or
guarantee of fewer D1 reads follows from storing rendered pages.

Required named paired acceptance cases:

| Case | Required proof |
| --- | --- |
| `af_prebuild_bytes` | Cold/live/warm HTML, JSON-LD, Markdown and map bytes, AF-2 tags and public metadata match on all 12 looks and expanded-stream samples; direct/negotiated identity and archive normalization remain exact. |
| `af_prebuild_gate_first` | Spy on artifact reads/builders: every private AF hit/miss/Accept/HEAD/conditional and every authenticated bypass avoids them; private blank bytes/headers and authorized private HTML stay unchanged. |
| `af_prebuild_no_owner_bytes` | Warm owner/reader/expired/revoked/Authorization then visitor, and the reverse; no Review/CSRF/session/draft bytes or headers in storage or public output; credentialed responses remain no-store without public validators/signals. |
| `af_prebuild_dependency_matrix` | Each listed effective mutation clears old copies before use across home/entries/archives/map; drafts and analytics preserve valid copies. Include theme, share cards, training receipts and private/public transitions. |
| `af_prebuild_publication_atomic` | Force invalidation failure: live mutation and deletion roll back together. Force build failure after commit: approved content stays live and ordinary rendering succeeds. |
| `af_prebuild_races` | Barrier-test fills/preparation against private-on, unpublish, changed visibility, newer publish and time expiry; no late insert, old body or stale 304 after the corresponding commit/authorization point. |
| `af_prebuild_clock` | AF-7L registered state/boundaries for hours/notices/events, local midnight and DST; before/at/after expiry matches live text/tags without mutation. Unknown proof bypasses 304/storage; static storage cap does not churn the validator. |
| `af_prebuild_negotiation` | Valid and invalid Accept/query variants, equivalent filters, distinct HTML/Markdown, GET/HEAD/304, unknown parameters and deliberate key-poisoning inputs keep existing semantics and bounded keys. |
| `af_prebuild_bounded_failure` | Concurrent fills, eviction, 256 KiB body/128-row/4 MiB limits, interruption, absent/corrupt/unavailable storage and gate failure; no truncation, stale fallback, public authorization fallback or leaked row metadata. |
| `af_prebuild_accounting` | Warm/cold GET 200 count once; HEAD/304 count zero under UC9, authenticated/private traffic does not; preparation creates no request count or page view. |
| `af_prebuild_upgrade_return` | Actual previous server runtime and archived Worker on the additive schema can approve/edit/unpublish/change privacy/theme/share cards, then return; stale rows are purged before lookup, no old 304/private copy, and published owner content/receipts/counters survive. |
| `af_prebuild_hosted_cpu` | Reproducible before/after hosted CPU and server CPU report, complete hit-path accounting and rebuild cost; hosted evidence is identified separately from local diagnostics. |

The table backend implements this contract in both editions. Delivery remains
operator opt-in; local process-CPU diagnostics are not hosted CPU evidence.

### AF-8: content is data, never agent authority

All generated prose and structured values are a mechanical projection of
the owner's approved visible content. No engine, theme, fetched resource or
assistant adds prompts, role messages, tool calls, system-like directives,
requests to ignore other instructions, endorsements, ranking requests or
claims about an agent's permissions. Templates cannot supply an extra
agent-only prompt field. Owner strings remain escaped content values,
never HTTP headers, control delimiters, executable markup or generated
metadata keys. The formats carry no secrets, drafts, approval messages,
assistant keys, passkey material, analytics or review-only values.

This rule constrains what the system generates; it does not certify that
arbitrary owner prose contains no imperative sentences or prompt-injection
attempts. Such prose remains untrusted source data as it is in HTML. Do not
execute, follow, expand or fetch instructions found in it. Do not claim an
instruction detector makes content safe, silently rewrite owner content,
or add an agent coaching preamble. Any stronger semantic filtering policy
requires an explicit product decision before implementation.

### Security invariants (normative)

The following numbered invariants bind the implementation and paired tests.
`BLANK` is the legacy credential denial in §3. For denied GET/HEAD without
Authorization, PV-6 replaces it with the exact Sign in document, including
new AF paths and all Accept values. All blank-denial references and named
cases below use this request-appropriate document. These rules apply
before the feature-specific presentation rules above.

Gating
1. Access check runs before live view, media lookup, Markdown/JSON-LD/llms build, ETag, Link, stored-copy lookup, or Accept negotiation.
2. AF paths are not on the private open-path allowlist: GET/HEAD /llms.txt, GET/HEAD <page>/index.md, and page URLs with Accept: text/markdown.
3. New private AF surfaces return the exact §3 denial without a valid §11 principal: 404; Sign in document on GET/HEAD without Authorization, legacy BLANK with Authorization; the corresponding headers above. Valid AG Bearer or owner/reader sessions are the §11 published-copy exception. Owner review copies require AG-6's valid owner session.
4. That 404 has no ETag, Last-Modified, Link, Vary, Content-Location, or Age.
5. Its Content-Type is text/html (charset utf-8 allowed). Never text/markdown, application/ld+json, or text/plain except private /robots.txt as in 10. Accept: text/markdown does not change this (no content-type oracle).
6. HEAD matches GET status and those headers, empty body.
7. If-None-Match, If-Modified-Since, If-Match, If-Unmodified-Since never change 3-6. Never 304 for anonymous private.
8. All gated private GET bodies within the same Authorization-header class are byte-identical to the §3 document (no size oracle by path existence). Hits and misses match: /index.md of a real page equals /missing/index.md.
9. Test: spy/monkeypatch live_view, media lookup, stored-copy read, Markdown/JSON-LD/llms builders — they are not called for anonymous private gated requests (timing oracle = content lookup before gate).
10. Private /robots.txt stays exactly `User-agent: *\nDisallow: /\n` with private, no-store, no-transform; no Sitemap; no extra User-agent groups. The AF-4 training switch has zero effect on private robots bytes. No ETag/Link.

Session and shared cache
11. Public cacheable representations (HTML, Markdown, JSON-LD-in-HTML, llms.txt, robots, feeds, sitemap) are built from the anonymous published view only.
12. A request with a valid owner or reader cookie never gets Cache-Control containing `public`, never a shared public ETag used to 304, and never an AF-7 stored copy from a shared cache. Owner HTML is Cache-Control: private, no-store, no-transform.
13. Owner-only bytes (Review link, CSRF, /review URLs, session name, draft counts, alert UI) never appear in any cacheable response (`public` or missing no-store) nor in published Markdown, JSON-LD, llms.txt, robots, feeds, or sitemap. AG-6 alone may show owner-authorized review prose in a no-store copy; secrets and public/published surfaces remain excluded.
14. A public AF-2 ETag, when present, hashes only anonymous published render dependencies plus release, origin, canonical path, Content-Type, approved training signal and AF-7L temporal state (the deployed minute token until implementation), with nothing from any session, using AF-2's dependency encoding. Media retains its binary-body encoding. Owner responses do not send that ETag (owner If-None-Match cannot 304 to public HTML missing the Review link; visitor If-None-Match cannot 304 to owner HTML).
15. Do not rely on Vary: Cookie. Defense is cookie-independent public bodies plus no-store on authenticated HTML (SV-PV1); only §11 private published Markdown/map may use principal-bound private revalidation. Test: visitor GET after owner GET of the same URL returns visitor bytes with no Review link; only the cookieless response may be public-cacheable.
16. AF HTML/Markdown/llms copies are never `immutable` and never max-age longer than today's public page/feed policy (feeds/sitemap 300s; pages today no-cache). Unpublish, private-on, or card-visibility change deletes stored copies before the next response. After private-on or unpublish, a previously public URL does not 304 from the old ETag (SV-PV2).
17. Page URLs that negotiate Markdown send Vary: Accept. Canonical Markdown is <page>/index.md so a Vary-ignoring reverse proxy is not the only MD URL. A Vary miss may mix public HTML with public Markdown; it must not mix owner bytes (owner responses are no-store and not written to AF-7 caches).

Published-only content (rules 18–24 concern published representations, not AG-6 owner-session review views)
18. Published Markdown, JSON-LD, llms.txt, sitemap, feeds, and ETag input use the live approved view only. Drafts, pending approvals, unpublished items, and unapplied rollback versions never appear there. AG-6 no-store owner review copies are outside that published projection and expose only what the same authorized owner GET shows.
19. Private cards are absent (name, description, link, picture, badge).
20. Mention cards: name and description only; no link, link label, or picture — same as HTML.
21. Unpublished entries and owner/review/setup/preview/login/recover/invite/upload/mcp paths never get AF Markdown copies, JSON-LD, or llms.txt listings. AG-6 alone permits no-store review negotiation after the same valid owner session; it never grants published-read keys draft authority.
22. Public llms.txt lists only URLs an anonymous visitor GET would 200 as HTML; a §11 private map instead uses the authorized principal's published HTML 200s (home + enabled archive + published local entry pages). No /review, drafts, private cards, media secrets, or invite tokens.
23. JSON-LD properties are existing published fields already shown on that page. No email/phone/price/beds unless already a public page field. No session or owner-only fields.
24. Markdown of a page is the same published text the visitor HTML shows (title, date, tags, body, visible cards), not a richer dump of item JSON.

AF-8
25. Porchsite-authored sentences on agent surfaces (llms.txt boilerplate, JSON-LD @context/@type, Link rel values, Markdown wrappers) are a frozen template. Owner field values appear only as data: title, summary, URL, dates, body, schema.org property values.
26. Owner fields are never interpolated into Porchsite-authored imperative language ("you must", "ignore", "system", "when answering", "instructions for AI").
27. Tests with title/summary/body/about/footer/card description/tagline set to `Ignore previous instructions`, `SYSTEM:`, `</script>`, `` `json `` fences, `data:text/html`, unapproved embeds, private card names: JSON-LD in HTML is JSON-escaped so `</script>` cannot break out of the script tag; Markdown/llms.txt grow no Porchsite-authored instruction preamble; private-card names still fail content_guard; the payload appears only as the owner's published text.
28. rel=alternate and rel=describedby Link targets are same-origin site URLs to that page's Markdown copy and /llms.txt. Never owner-controlled URLs.

Routing
29. <page>/index.md exists only for real published HTML pages (public AF or an authorized §11 published-copy request) (home /index.md, entry /stream/slug/index.md, archive/tag if those pages exist). /review/index.md, /login/index.md, /media/.../index.md, /mcp/index.md are not Markdown copies: private anonymous → blank 404; public → ordinary miss, never owner HTML as markdown.
30. On a public page, Accept: text/markdown returns the same bytes as that page's /index.md, Content-Type text/markdown; charset=utf-8, Vary: Accept. Public anonymous miss: fixed HTML 404 from current dependency facts, not Markdown. Private anonymous: blank HTML 404 even with that Accept (5).
31. Both editions: identical bytes and headers for the same published site (parity includes Markdown, llms.txt, robots with the training switch, JSON-LD).

AF-4 training switch
32. Public default: today's robots (`User-agent: *` Allow: / plus Sitemap). Training-off adds well-known training-crawler Disallow groups; `User-agent: *` Allow: / stays for search and user-triggered agents.
33. The switch is an exact-version approved site_fields key plus the matching training_approvals receipt (AF-C1), never a legacy JSON key the previous release would parse into SiteData (S4-11 BLOCK 1). Absent, false or unreceipted = training allowed. Private robots ignore it (10).

Protocol leftovers
34. /.well-known/porchsite-release, OAuth metadata, /login, /mcp stay as today: no site content, no llms listing of private pages.

### Named security acceptance cases (paired in both editions)

Each row names a required implementation test, not an existing passing
result. Run denial cases against anonymous, expired, revoked, malformed
and unknown credentials, and routes outside §11's grant. Valid AG Bearer
and owner/reader sessions exercise §11's published-copy exceptions instead
of the old every-cookie denial. Owner-review negotiation is AG-6 only.
The named cases implement the corresponding numbered invariant above.

| Rule | Required test name | Assertion |
| --- | --- | --- |
| 1 | `af_gate_before_representation` | Access precedes views, media, builds, validators, links, storage and negotiation. |
| 2 | `af_no_private_open_paths` | AF paths never enter the private allowlist. |
| 3 | `af_private_exact_blank` | Without a valid §11 principal, new private AF surfaces return the exact §3 denial: GET/HEAD without Authorization uses Sign in, Authorization retains BLANK; valid AG or owner/reader sessions follow the named §11 authorized-copy cases. |
| 4 | `af_blank_no_metadata` | No validators, links, Vary, Content-Location or Age. |
| 5 | `af_blank_html_type` | Accept never changes denial Content-Type. |
| 6 | `af_private_head` | HEAD has GET status/security headers and empty body. |
| 7 | `af_private_conditionals` | All four conditional fields preserve the denial. |
| 8 | `af_private_hit_miss_identity` | Existing and missing copy paths have identical §3 denial bytes within each Authorization class. |
| 9 | `af_denial_lookup_spies` | All content, media, copy and builder spies remain uncalled. |
| 10 | `af_private_robots_unchanged` | Exact disallow-all bytes/headers under every training setting. |
| 11 | `af_cache_anonymous_view` | Every public artifact derives from the anonymous approved view. |
| 12 | `af_authenticated_cache_bypass` | Owner/reader/AG requests bypass shared copies and public 304s; private HTML is no-store, only §11 private Markdown/map may revalidate with a principal-bound private tag. |
| 13 | `af_no_owner_surface_leak` | Owner-only fields occur in neither public cacheable bytes nor published agent copies; AG-6 review copies remain valid-owner-only, secret-free and no-store. |
| 14 | `af_etag_public_input` | Hash current published dependencies, release, canonical URL, Content-Type, approved training signal and AF-7L temporal state using AF-2; changing only training changes the tag; owner/visitor validators cannot cross roles. |
| 15 | `af_owner_then_visitor` | Owner request followed by visitor request never transfers owner decoration. |
| 16 | `af_invalidate_before_serve` | Unpublish, private-on and card visibility invalidate copies and old tags. |
| 17 | `af_accept_cache_separation` | Vary: Accept plus canonical direct copy; no owner bytes under either variant. |
| 18 | `af_approved_only` | Draft, pending, unpublished and unapplied versions never affect published artifacts; AG-6 private no-store owner review is tested separately and grants no published-key authority. |
| 19 | `af_private_card_absent` | Every private-card field is absent from all new surfaces. |
| 20 | `af_mention_card_projection` | Mention cards expose only displayed name and description. |
| 21 | `af_reserved_and_unpublished_paths` | No AF copies or map entries for owner/protocol/capability or unpublished paths; AG-6 owner-session negotiation is the sole review exception and remains absent from maps. |
| 22 | `af_map_links_resolve` | Public map entries resolve to anonymous HTML 200; §11 private map entries resolve to that valid principal's published HTML 200 and private copy. |
| 23 | `af_jsonld_visible_fields` | Structured facts use only existing approved visible fields; paired browser tests prove inline data or the discovered same-origin twin under unchanged CSP. |
| 24 | `af_markdown_visible_text` | Markdown omits fields and items absent from the visitor page. |
| 25 | `af_frozen_wrappers` | Engine-authored words stay fixed across owner payload changes. |
| 26 | `af_no_imperative_interpolation` | Owner data never enters engine-authored instruction language. |
| 27 | `af_injection_payload_matrix` | Payload matrix preserves JSON data boundaries and content guards without new instructions. |
| 28 | `af_generated_link_origins` | Alternate and describedby target only generated same-origin paths. |
| 29 | `af_copy_route_matrix` | Copies exist only for real pages; reserved and missing paths remain misses. |
| 30 | `af_negotiated_copy_identity` | Negotiated/direct Markdown match; public anonymous misses stay fixed HTML 404. |
| 31 | `af_cross_edition_http_parity` | Bytes and headers match for every new representation and training setting. |
| 32 | `af_public_robots_choices` | Default unchanged; off adds training-only denial groups. |
| 33 | `af_training_additive_approval` | Exact-version field and owner-publication receipt; absent/false/unreceipted allowed; legacy JSON unchanged; private ignores it. Include AF-C1 receipt cases above. |
| 34 | `af_protocol_routes_unchanged` | Release, OAuth, sign-in and MCP behavior stays unchanged. |

### Compatibility and paired acceptance

Until implementation and all acceptance gates pass, this proposed section
is not a claim that shipped releases expose these paths or headers. Where
it changes older public discovery/cache descriptions, this section governs
the AF implementation; private-site and approval safety rules always win.

New settings and generated artifacts live only in additive schema
structures; previous-release tests, rendering and approval continue to run.
A previous runtime ignores these fields and artifacts and must still start
and render legacy content. Do not enlarge legacy JSON schemas or require
an assistant reconnect. Rollback may remove AF features; it must not
weaken private mode's existing release floor.

Both editions must share golden HTTP fixtures at fixed origin and clock
for every look and page type. Required cases: representation bytes and
ETag parity; direct/negotiated copy equality; weak/strong/list/wildcard and
malformed validators; HEAD/304 bodies and headers; HTML/Markdown q-values,
case, wildcard and q=0 negotiation; archive/tag/external/missing paths;
draft versus approval versus restore changes; training default/off/on and
final-host override checks; Unicode and injected Markdown/HTML/header
content; JSON-LD data-block escape and visible-fact accuracy; valid map
links and bounds; no external build calls. Exercise private denials and
old public ETags before and after a public-to-private transition, with no
session, owner, reader, expired/revoked cookies and bearer tokens. Probe
shared stores directly for private/personalized bytes and assert access
precedes all content/artifact lookups. Prior-release upgrade/rollback and
the existing parity, conformance and mutation gates remain required.

## 11. Agent access to private sites (proposed; implementation pending)

This section specifies AG-1 through AG-6 in both editions. It is a proposal,
not a claim that the released engine accepts these credentials or serves
these copies. Implementation requires paired tests, security and code review,
then the ordinary release gates. The compatibility rule remains additive.

The first implementation slice provides AG-1/AG-3 credentials, owner
issuance/revocation and the reduced MCP authority boundary in both editions.
The second slice provides AG-2 in both editions: all five published-read
tools are registered, with the bounded listing, search and shared continuation
contract below. Writer connections gain the three read tools while retaining
their existing drafting behavior. AG-4/AG-5 private HTTP grants and AG-6 owner
review copies remain pending: this checkpoint preserves the existing private
HTTP denials. It is not a complete AG release or acceptance claim.

Anything an agent can already reach is made easier to read. Friendliness
never grants additional authority. There is no separate agent mode and no
second approval of agent representations. The approved content remains the
source; light copies are mechanical views of it. This covers the business
requirements for a holder of a valid login to read private content and keep
its own private copy (UC5), unchanged anonymous denials (UC6), and one owner
approval (UC11). The same behavior works without any hosting-provider service.

### Authority and the relationship to §10

Published-only keys, reader passkeys and owner passkeys are distinct
principals. Existing OAuth connections and `psk_` assistant keys retain their
existing MCP drafting authority; they do not acquire private HTTP or owner
session authority from AG. An owner session is not an MCP credential.

| Principal | Published page HTML and light copies on a private site | Owner review light copies | MCP |
| --- | --- | --- | --- |
| No valid credential | Request-appropriate §3 denial | Existing denial | Existing HTTP 401 |
| New published-only key | Published pages and private map only | Never | Five published-only read tools |
| Valid reader passkey session | Same published pages as existing reader HTML | Existing reader refusal | Not a credential |
| Valid owner passkey session | Published view, without owner decorations in copies | Existing authorized owner GET pages | Not a credential |
| Existing writer key or OAuth token alone | No new HTTP authority | Never | Existing tools, plus the new published read tools |

On a private site AG explicitly replaces §10's blanket denial of new
Markdown/map paths **only** for those valid published-read principals. It
also permits their principal-bound private validators as described below.
All anonymous/expired/revoked/invalid denials, private robots bytes, public
anonymous representations, AF-7 public-store exclusion, and owner HTML
no-store behavior remain normative. AG-6 is a separate, owner-session-only
exception to the §10 exclusion of review Markdown; it never enters the
published projection, discovery map, or public JSON-LD.

Validate the live principal before content lookup, route-existence tests,
negotiation, Markdown/map building, validators, discovery or any derived
store. HTTP credential selection is deterministic: a present Authorization
header must be one valid AG Bearer; it cannot fall back to a cookie or combine
with cookie authority. Without Authorization, validate the existing owner
session, then reader session. Invalid/duplicate/malformed Authorization or
credentials supplied in query/path/cookie never become a grant. Existing
request-origin/Host protections still apply; a request cannot pin an origin
or gain authority through Host or forwarded headers.

### AG-1 and AG-3: one published-only key type

Fold the read-only assistant and trusted agent reader into one capability,
`published_read`. On `/review/assistants`, the signed-in owner chooses
"Read only — published pages" when creating a named key. Existing drafting
key creation stays distinct and unchanged. Name the scope in the listing;
never suggest that a published-read key can draft or approve. Creating or
revoking access uses the existing owner session, CSRF and same-origin checks,
not a content approval request. No MCP tool can mint, broaden, rotate or
revoke these credentials.

Use NEW `agent_read_keys` and `agent_read_key_events` tables. Do not add a
scope flag to `assistant_keys`, insert a read key in that table, or reuse
its `psk_` prefix: older runtimes would interpret it as a drafting credential.
Use the distinct `prk_` prefix followed by 24 cryptographically random bytes
in unpadded base64url form (192 bits of entropy). The identifier is an
independent opaque id, never the secret or its hash.

`agent_read_keys` holds `id` (primary key), `name`, `key_hash` (unique lowercase
SHA-256 of the entire token), `created_at`, `expires_at`, `last_used_at`
(nullable), `revoked_at` (nullable), and the existing `owner_epoch` at issue.
The scope is fixed by table and prefix, not mutable caller data. Lifetime is
90 days from issue; there is no refresh token. Use existing UTC timestamp
conventions. Names use the current assistant-key name validation and escaping.
Every named agent gets its own row. A new key is not a conversion of a writer
key; revoke a writer separately if the owner wants to remove its authority.

The token is disclosed once, only in the owner-authenticated creation
response, under private no-store headers. This narrowly defined
create POST response is the sole exception to the prohibition on tokens in
HTML. A later GET never discloses it. The token must not be converted to Markdown, logged, embedded in a URL, or returned by
MCP. Later listings show name, scope, created, expiry and last successful
use, never the token or hash. Refresh/back navigation cannot redisclose it.
No exports, content imports, restore-as-draft, revisions or tool results carry
credential or audit rows. Content import cannot plant an access grant.

Send the token only as `Authorization: Bearer <token>` over HTTPS outside
existing localhost test allowances ([RFC 6750 §2.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-2.1)).
Never accept it from a URL, query, fragment, cookie, MCP argument or Referer.
Never propagate it into Location, Link, canonical URLs, page text, error
messages, analytics, public discovery or outbound requests. Redact
Authorization and key-issuance responses in diagnostics. Do not fetch remote
resources with the credential.

Every request and every MCP tool invocation performs a live hash lookup:
matching prefix/hash, `revoked_at IS NULL`, `expires_at > now`, and issued
owner epoch equal to current owner epoch. Do not cache a grant in an MCP
connection, session, transport props, process, KV or derived table. Recheck
before returning protected bytes or 304 after awaited rendering; an auth
lookup failure fails closed. Successful use may update `last_used_at`; it
is owner-only metadata and not a content or artifact dependency. Recovery
that changes the owner epoch invalidates old AG keys even if an older
runtime performed that recovery and did not know the new tables.

Revocation sets `revoked_at` and appends one event in the **same** owner POST
transaction/batch. Failure of either write rolls both back. Audit rows hold
only event id, UTC time, owner actor identifier, key id, escaped name snapshot
and event kind (`created` or `revoked`); no token/hash, IP, user agent, path,
page body or per-read log. A repeated revoke is idempotent and creates no
second event. The owner can see the revocation history on the assistants
page. Revocation takes effect at the next authorization check, including
calls on an already-open MCP connection. A stalled operation must recheck
before returning bytes or a conditional success; already delivered bytes or
an agent's own retained copy cannot be recalled.

### AG-2: small published read tools

Add `page_get`, `pages_list` and `search` to the normal tool catalog. Existing
writer keys and OAuth connections retain all existing tools and their
existing `site_state`/`site_check` behavior. For a published-read principal,
`tools/list` contains only `site_state`, `site_check`, `page_get`, `pages_list`
and `search`. Initialization exposes no site content or private draft guide.
The restricted guide describes these five capabilities as facts; it does
not expose the drafting workflow, owner metadata or a private site dump.

The restricted guide-reuse revision hashes the restricted read guide and
scope, using SP-S3's encoding rules; a writer-guide revision is always stale
for `published_read`. A changed/missing/foreign guide token returns the full
restricted guide, never the writer guide. Since writer tool lists gain the
three new read tools, the implementation changelog entry must set
`reconnect: true` and explain that apps which cache their catalog need to
reconnect or refresh tools. Existing
writer behavior is not removed or changed.

Enforce this allowlist before argument-dependent content work in **all**
transports: Worker fast dispatch, SDK fallback, current and legacy protocol
versions, JSON and SSE, and server dispatch. Direct calls to an unlisted
known tool are denied exactly like unauthorized/invalid-tool calls, not
silently forwarded to the writer handler. Every mutating, draft-reading,
history, stats, image, import, approval, theme and owner tool is denied.
Read-only declarations/annotations and a filtered tool list alone are not
an authorization mechanism. Refusal changes no content, approval, credential,
media or artifact row. MCP transport responses carrying restricted content
are private, no-store, no-transform; existing Origin/authentication behavior
and no-content HTTP 401 for an invalid Bearer remain in place.

All five tools use only the current live approved **reader** projection,
with private cards absent and mention cards limited to name and description.
Never derive it by fetching drafts and deleting a few fields. Published
fields use the same exact-version approval/receipt rules as HTML. Never
return pending versions, history, approval notes/ids/URLs, owner names,
CSRF/session data, assistant key metadata, stats, unpublished entries or an
unapplied rollback. A live entry with a pending newer version returns only
the live version. A missing private site item does not reveal drafts.

| Tool | Inputs and result |
| --- | --- |
| `page_get(path)` | A same-site published page, `{path, canonical_url, title, date?, tags, markdown}`. Markdown is the same title/date/tags/visible body as its reader HTML, using AF-3's mechanical converter and wrappers. |
| `pages_list(stream?, tag?, since?, cursor?, limit?)` | `{pages:[{path,title,changed_at}], next_cursor}` over published local entry pages, plus home and enabled archives when no entry filter is supplied. No external entry URL is fetched or treated as a local page. |
| `search(query, cursor?, limit?)` | `{results:[{path,title,excerpt}], next_cursor}` from the same authorized published corpus; substring terms must all match title or visible text, case-insensitively, with no stemming/ranking claim. Excerpts are at most 240 Unicode scalar values of owner text. |
| `site_state(full?, ids?, guide?)` with a published-read key | A restricted `{scope:"published_read", site:{title}, pages:[{path,title,changed_at}], next_cursor, guide?}` using the bounded listing below. `full:true` or `ids` is refused before any draft lookup; it never invokes the writer state loader. The fixed guide is the restricted read guide, with the existing guide-reuse contract. |
| `site_check(deep?)` with a published-read key | The existing quick/deep result shape over the live approved graph only; missing draft targets are ordinary missing published links. Existing crawl limits and incomplete-crawl reporting apply. No live mutation, remote fetch, drafts or owner routes. |

`path` is an absolute-path reference beginning with one `/`, not a URL,
network-path reference, traversal, fragment, credential, encoded slash or
backslash. Resolve only AF page routes and validated archive filters; direct
Markdown input normalizes to the corresponding HTML path. Reject duplicate,
unknown and invalid filters, as AF does. No arbitrary HTTP fetch, media read,
filesystem path, owner route, preview or MCP URL is performed. Unknown,
unpublished or owner `page_get` paths give a bounded `not_found` tool result,
not an anonymous BLANK response or a draft dump. Input errors are tool
refusals without a content lookup. No new body/metadata instruction preamble
is added; owner prose remains data under AF-8.

Listings/search default to 20 rows, maximum 50; query is 1–200 Unicode scalar
values after trimming Unicode White_Space, normalized by Unicode 15.1 NFC
then default lowercase (including contextual final sigma, without locale),
whitespace-separated AND terms. Both editions use the same packaged Unicode
table, including on runtimes with newer Unicode data. Compare text after the same NFC/lowercase normalization in both
editions. Order results by normalized canonical path (UTF-8 byte order), not
locale, database collation or score. `stream` and `tag` have the existing
published route grammar. `since` is an RFC3339 UTC timestamp and selects
`changed_at > since`; timestamps are facts, not access grants.

For an entry, `changed_at` is the maximum existing UTC `published_at` of its
live version and live site dependencies, plus the active installed theme's
`installed_at` when present. For home/archive/tag listings use the maximum
of reader-visible live publication times and that theme installation time.
Invisible private-card rows are never timestamp or listing inputs. It is a
publication/change date, not the date in the owner's prose; validators remain
the authoritative representation-change check (media metadata repairs need
not invent publication timestamps).

Pagination uses a versioned base64url JSON cursor containing last path,
query/filter digest and a digest of the current reader-visible listing and
search corpus (not hidden raw rows). Cap encoded
cursor input at 2048 bytes; parse strictly. Bind it to the current principal
id and scope with an engine-computed digest. A cursor never authorizes a
read, contains a credential, or bypasses fresh filtering. If the published
digest changed, return `cursor_stale` and require a fresh first page; do not
silently skip/duplicate rows across snapshots. Malformed/foreign cursors are
refused. More than the maximum rows is represented by `next_cursor`, never
an unmarked partial answer. No private cursor or body is persisted by the
engine. Restricted `site_state` uses the same default 20-row bound and cursor
as a first `pages_list` call; callers use `pages_list` for continuation.

Each result is rendered from one reader snapshot. Recheck its visible
publication/theme dependencies before returning; crossing a display-clock
minute while preparing a listing refuses with `cursor_stale`. A single-page
read retries one changed snapshot, then refuses with `content_changed` if
it changes again. Revocation is still rechecked by the outer tool boundary
immediately before protected return. These checks do not store a private body
or extend authorization across requests.

### AG-4 and AG-5: HTTP Markdown and the private map

A valid AG key may GET/HEAD published page HTML, its `<page>/index.md`, or
negotiate Markdown at the HTML URL, and read `/llms.txt`. Granting the same
published HTML is necessary so every map target is a real HTML 200 for that
principal. Bearer-authorized private HTML uses exactly the existing reader
HTML bytes, without an owner Review link, and `Cache-Control: private,
no-store, no-transform`. It sends no ETag (public AF-2 or private AG),
Last-Modified or Content-Signal and never returns a conditional 304. It
never looks up, fills or delivers an AF-7 row or another shared copy. Cheap
private revalidation is limited to Markdown and the map; HTML GET/HEAD
retains the existing reader HTML policy.
This HTTP grant covers no owner, write, protocol, preview, raw-item, feed,
sitemap or arbitrary media endpoint; existing passkey privileges remain as
they are. Bearer validity never makes a draft address exist.

Valid owner and reader sessions can read the same private page copies and
map without a new toggle, credential or approval. Owner-page copies still
use the published reader projection: no Review link, owner navigation,
CSRF/session labels or richer private-card fields. Direct/negotiated body
and tag identity, Accept grammar, 406 behavior after successful access,
canonical archive filters, safe Markdown URLs and discovery bounds follow
AF-3/AF-6/AF-8. GET and ordinary HEAD have the same status and representation
headers, including correct UTF-8 Content-Length when present; HEAD has no
body. Private published misses are ordinary authorized misses, no-store
and without a validator. Missing/unpublished addresses do not return draft
bytes or distinguish draft existence.

The private map contains only URLs this same principal can GET as published
HTML 200, using the existing home/archive/local-entry order and 50-link,
16-KiB complete-line limits. No review, draft, token, per-agent identifier
or credential-bearing link is listed. The map is itself private. Private
robots stays exactly `User-agent: *\nDisallow: /\n`, no Sitemap, no validator
or map discovery. Ordinary anonymous feeds/sitemaps remain gated as before.

Successful **private published light** responses (Markdown/map, not owner
review) use exactly `Cache-Control: private, no-cache, must-revalidate,
no-transform`. This permits only the agent's own private cache, with online
revalidation before reuse, never a shared cache ([RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html)).
They have `X-Robots-Tag: noindex`, existing restrictive Markdown CSP, no
Content-Signal, Last-Modified, Age, public freshness, stale-if-error,
stale-while-revalidate, immutable, CDN override or Set-Cookie. Negotiated
URLs vary on Accept; direct copy URLs do not. Vary may additionally name
Authorization and Cookie as a private-cache partition hint, but never as
the protection against shared storage. A reader/owner's ordinary private
HTML remains private, no-store, no-transform.

Private validators use `W/"ag-sha256-<lowercase SHA-256 hex>"`. Hash UTF-8
of the compact JSON array `["ag-private/1", kind, id, epoch, U, T, G, B]`:
all members are strings, epoch is decimal, U is the validated canonical URL,
T is Content-Type, B is the body, and G is SHA-256 of UTF-8 compact JSON
`[U,T,B]` for the current approved reader representation. Hidden fields,
private cards, owner metadata and raw database revisions are not validator
inputs. The internal concurrency guard may inspect authoritative state but
is not exposed as a validator. Use the AF shared UTF-8 JSON string
encoding/fixtures in both editions.
No raw credential, hash of the secret, name or session cookie enters the
ETag or body. Bind owner/reader tags to the individual valid session id,
not just the role. Bind a key tag to its individual key id and epoch.
Where existing session records lack an independent opaque id, add NEW
`agent_read_session_ids(kind, session_hash, id)` metadata with primary key
(kind, session_hash) and unique random id. Only a successfully validated
existing session may create this mapping atomically; reread after a
concurrent insert. It is not a session, auth grant, body store or auth cache.
Never accept it instead of current session/epoch/passkey validation. Keep
the opaque id stable for that session and remove expired/revoked mappings
without weakening the original session's checks. Old sessions do not gain
privileges from a mapping; old runtimes ignore the table.
Do not reuse public AF-2 tags or a validator belonging to another principal.
Direct and negotiated Markdown use the same normalized HTML canonical URL.

Authenticate and recheck current authorization/content dependencies before
conditional evaluation and immediately before returning a protected body
or 304. Use AF-2's If-None-Match grammar/precedence for GET/HEAD; a matching
private tag returns an empty 304 with the same private cache policy and
discovery metadata. A foreign/public tag returns the current 200, never
304; a revoked or expired credential returns BLANK regardless of all
conditionals. Do not treat If-Modified-Since as authority or add writes
through If-Match/If-Unmodified-Since. Removal, content changes, privacy
transitions, session revocation or key revocation invalidate the relevant
successful check before reuse. No origin-side private response table is
created: render private views in request memory and let the authorized
agent hold its own private copy. No bytes, hashes, URLs or copies of private
content enter AF-7, Cache API, Workers Caching, KV, a service worker, static
prebuild or a new shared artifact table. Private-on still atomically clears
public AF-7 rows; flags on/off never change this gate.

Public anonymous HTML/Markdown/map/JSON-LD/ETags keep §10. Any credentialed
public-site request still bypasses AF-7 lookup/fill/delivery and retains the
existing no-store policy without public validators; AG private caching is
not a default-on public-cache change. Private traffic and internal views
never become UC9 public-agent counters or per-page analytics events.

### AG-6: authorized owner review copies

An agent already holding a valid **owner passkey session** may request
`Accept: text/markdown` on an existing owner-authorized GET `/review` or
`/review/...` page that successfully renders review HTML. Run the same
`requireOwner` and all page-specific checks first. Do not add unauthenticated
`/review/index.md` aliases, new draft endpoints or a way to exchange a key
for owner cookies. Bearer grants, reader sessions, OAuth and writer keys
never authorize these copies. Reader requests retain the existing 303 to
`/`; anonymous private requests retain BLANK. Public-site anonymous owner
routes retain their existing sign-in refusal, not a new Markdown page.

Build a mechanical read view of that owner's visible page: title, status,
visible item changes, notes and existing visible prose. No hidden inputs,
CSRF, cookies, bearer material, passkey challenges, invitation/recovery
secrets, key-issuance tokens, scripts, actionable forms or new instructions.
Do not fetch a proposed external link. Denials, redirects, non-HTML routes,
POST action responses and the token-issuance response are never converted.
A non-owner cannot infer draft existence via negotiation or timing.

Review copies always use `Cache-Control: private, no-store, no-transform`,
`X-Robots-Tag: noindex`, restrictive Markdown CSP and `Vary: Accept`; no
ETag, Last-Modified, public discovery Link, map entry or shared/persistent
copy. A conditional request cannot turn an owner action or review read
into a 304 bypass. Existing HTML actions and CSRF protections stay exactly
as they are. This read view adds no approval buttons, automatic approval,
second approval request, agent mode or duplicate revision. The one owner
publication creates the published page and all its read representations.

### Normative security invariants and named paired tests

Every rule below is normative in both editions. Denial references, including
BLANK, mean the request-appropriate §3 private 404. PV-6 supplies its fixed
111-byte Sign in document for denied GET/HEAD without Authorization; any
Authorization header retains the exact 68-byte legacy BLANK. Neither path
reflects the requested URL or grants authority. Both retain private
no-store/no-transform, noindex, the denial CSP, HTML Content-Type and no
Location, ETag, Last-Modified, Link, Vary, Content-Location, Age or
WWW-Authenticate. HEAD has GET headers and no body. Unauthorized existing
and missing paths are indistinguishable within each header class.

| Rule | Invariant | Named paired case |
| --- | --- | --- |
| P1 | Friendliness never widens access; anonymous/expired/revoked/malformed/unknown credentials keep the prior private denial. | `ag_private_blank_without_principal` |
| P2 | No agent mode or second approval; published light copies use the live approved projection. | `ag_approve_once` |
| P3 | No private content in a shared cache/store, log, feed, sitemap or anonymous map; no new private artifact table. | `ag_no_shared_private_store` |
| P4 | New table and non-psk prefix; older runtimes reject read keys, never draft with them. | `ag_key_prefix_new_table` |
| P5 | Live gate and credential lookup every request/call, no cached grants; revoke denies the next request. | `ag_revoke_immediate` |
| 1 | Existing psk writer capabilities stay unchanged. | `ag_writer_unchanged` |
| 2 | Owner-only issue, one disclosure, SHA-256 only, named separate row, 90-day lifetime. | `ag_key_issue_once` |
| 3 | Hash/revoked/expiry/epoch live lookup; misses equal; last use owner-only. | `ag_key_lookup_live` |
| 4 | Secret only in Bearer header and one owner issuance display, never URLs, redirects, discovery, tools, errors or logs. | `ag_bearer_header_only` |
| 5 | AG-1/AG-3 share published_read, with no owner/draft/session authority. | `ag_read_principal_unified` |
| 6 | Passkey sessions are not MCP keys or AG rows; rollback cannot convert principals. | `ag_principal_types_separate` |
| 7 | MCP keeps authentication and no-content invalid-Bearer HTTP 401. | `ag_mcp_auth_unchanged` |
| 8 | Exactly five reduced tools; list and direct calls enforce before dispatch on every transport; denied writes change nothing. | `ag_tools_enforced` |
| 9 | All reduced projections omit drafts/history/stats/private cards/review data/secrets; mentions only name+description. | `ag_published_only_projection` |
| 10 | page_get matches published reader text; authorized misses do not reveal drafts or owner routes. | `ag_page_get_reader_identity` |
| 11 | Full writer keys/OAuth preserve their existing tool set and behavior. | `ag_writer_unchanged` |
| 12 | Gate precedes view/media/builders/ETag/Link/AF-7/negotiation. | `ag_private_blank_without_principal` |
| 13 | Invalid principals receive exact BLANK on every new private path, GET/HEAD/all conditionals; no builders or stored reads. | `ag_private_blank_without_principal` |
| 14 | Valid AG or owner/reader sessions get published private Markdown/map; never owner-only bytes. | `ag_private_markdown_authorized` |
| 15 | Private cache policy, principal-bound validators, no AF-7; foreign/public/revoked tags never authorize 304. | `ag_etag_not_shared` |
| 16 | No URL/query/path key or Host/auto-pin authorization. | `ag_bearer_header_only` |
| 17 | Private map lists only this principal's published HTML-200 pages; anonymous gets BLANK. | `ag_private_map_scope` |
| 18 | Public anonymous AF unchanged, Bearer/public session never fills AF-7. | `ag_public_unchanged` |
| 19 | Existing requireOwner guards review; reader refusal unchanged; published keys never read review/drafts/notes. | `ag_review_not_published_only` |
| 20 | Owner-session review copies stay no-store; no second approval. | `ag_owner_review_markdown` |
| 21 | Revoke and event atomic; next lookup and a stalled returning call revalidate. | `ag_revoke_immediate` |
| 22 | Owner-only named listings and revocation audit contain time/actor/id/name, no secrets or bodies. | `ag_key_audit_atomic` |
| 23 | Additive new tables; old code ignores them; return never resurrects revoke. | `ag_upgrade_return` |
| 24 | Actual previous runtime rejects AG at MCP/pages, writer keys still work; raw-bundle residual documented. | `ag_upgrade_return` |
| 25 | Private-on purges public AF-7 and never prebuilds private copies. | `ag_no_shared_private_store` |

Also require `ag_bearer_html_published`: a valid AG Bearer GET of each
private-map HTML target returns published reader HTML 200, including enabled
archives and validated filters. Unknown/unpublished paths are authorized
misses, never drafts; review/protocol paths remain denied.

Also require `ag_bearer_html_cache`: private HTML GET and
ordinary HEAD have the same reader body/status/representation headers
(HEAD body empty), exact private no-store policy and no public or AG
validator, Last-Modified or Content-Signal. If-None-Match (public tag,
AG Markdown tag or `*`) and If-Modified-Since never produce a 304. Spy on
AF-7 lookup/fill/delivery and inspect all shared stores: none is used or
populated by those requests. Repeat after private-on and revocation;
revocation gives exact BLANK, even with old validators.

Also require `ag_read_pagination` (bounded, complete continuation, stale and
foreign cursors, Unicode/query parity), `ag_recovery_epoch`,
`ag_revocation_delivery_race`, `ag_restricted_guide_revision` (writer token
is stale for the restricted guide), and `ag_session_validator_partition` (stable
per-session opaque id, no credential/hash disclosure, no grant from a stale
mapping). Test all owner/reader/agent/expired/revoked/
anonymous combinations before and after private-on, public-on, unpublish,
republish and recovery. Spy on all content builders and storage boundaries.
Read tools cannot mutate content, change approval status or acquire owner
capabilities. Deliberate instruction-like owner text remains inert data;
AF-8 URL, script-escape and prose/layout oracles continue to apply.

### Compatibility, migration and implementation acceptance

Reserve CF `0024_agent_read_keys.sql` and PG migration `0018` after AF-7's
0023/0017 for the credential and audit tables. The session-identity metadata
table follows in a later additive migration with AG-4/AG-5. All three new
tables are additive; migrations start empty with no credential backfill,
no conversion of old rows and no change to old token lookup. Do not modify
historical migration bytes. Previous runtimes remain runnable on the new
schema, ignoring these tables. Preserve revocation events/rows across an
ordinary binary rollback and return; content restore/import never grants
or revives a credential. Restoring an old database snapshot is a distinct
operator recovery action and cannot be advertised as preserving later
revocations.

Run actual released `2026.10.17-6312f5a` server and checksum-verified archived
Worker on the additive schema. Exercise new keys against initialize,
tools/list, forbidden direct calls and HTTP paths while rolled back:
AG MCP 401 and private pages BLANK, never drafting or reading review. Verify
existing writer keys still work. Revoke under new code, roll back and return;
revoke remains effective. Repeat owner recovery under the old runtime;
old-epoch AG keys remain denied on return. Existing publication, receipts,
stream settings, counters, public prepared copies and guide reuse survive.

Document the existing dashboard/raw-bundle C3 residual (§4): a hosting
account can bypass the supported downgrade check or restore an older
private-unaware binary/database. AG cannot prevent that operator action;
it must not claim private-content confidentiality against it. Distinct
prefix/table prevents *AG credentials* from gaining old writer authority;
it does not repair arbitrary historical private-unaware code or erase
already delivered private copies.

Implementation acceptance includes all named paired cases, full native
12-look/public and private HTML/Markdown/map parity, full MCP transcript
parity including SDK fallback/fast forms, migration and actual-runtime
upgrade checks, conformance/mutations, and owner/reader/agent browser checks.
Compare denial bytes/headers with the released private baseline; compare
published copies with the authorized reader HTML, including table/prose
conversion when MD-1 is available. Inspect real shared artifact rows and
request logs for private content/secrets. Measure bytes and conditional
rechecks without promising traffic, ranking or CPU improvements. AF-7H,
public default enablement and other backlog work are outside this proposal.

## Open questions

- Q1. Answered: yes. An assistant installs the Cloudflare edition into a
  person's own Cloudflare account through Cloudflare's MCP server or API,
  with no GitHub account (`cloudflare/INSTALL.md`).
- Q2. Which consumer assistants connect to a remote MCP server with OAuth
  today, and do any need an adapter?

### PERF-1: bounded public reads

This amendment replaces body-derived validators on anonymous public text
representations in both live and prepared public text. It does not change
media validators or private principal-bound validators. Prepared copies stay
off by default; no private body is prepared or shared.

Run the live private-site gate first. Any Authorization header or owner/reader
cookie bypasses the public conditional shortcut, including invalid or expired
credentials. Resolve representation negotiation and archive query validation
before a successful conditional response, after the access gate. A missing,
redirecting or invalid resource cannot become 304, including with `*`.

Read the current render-dependency facts in one database statement instead of
rendering a body to compute its validator. Include every live item identity,
version, slug, publication and creation timestamp; approved site extensions
and their exact values, private/training receipts, selected theme digest,
share-card references and media dimensions consumed by rendering (PERF-3).
A count or maximum
version alone is insufficient. The identity also includes engine release, canonical
origin and path with normalized archive query, selected Content-Type, approved
training signal, and AF-7L temporal state. Until that proposal is implemented,
the current UTC-minute token remains the conservative deployed behavior.
AF-7L supplies the proof for removing it; it is not removed by assumption.
A theme, media/share-card metadata, approved extension or
receipt change must invalidate the identity as well as a live item change.
Derive these facts from committed data on every request, so writes by an older
runtime also change the identity without a migration or trigger.
No pending body, session identifier or credential enters the identity. Hash
the canonical JSON encoding of these facts and identity fields with SHA-256;
use W/"dep1-<64 lowercase hex digits>". This is a dependency hash, not a body
hash. Equivalent direct and negotiated Markdown use the same canonical URL
and type. Canonical object keys, row ordering and timestamp strings agree in
both editions. A changed body must imply changed dependencies or temporal state.

A matching public GET/HEAD returns an empty 304 without liveView, HTML or
Markdown parsing, body hashing, a prepared-copy snapshot/read/fill, or request
accounting. It retains the corresponding Content-Type, public cache policy,
Content-Signal, discovery Link and Vary headers. HEAD never returns a body.
A miss builds one approved reader view while dependencies stay unchanged and
passes it to all page, archive and missing-page helpers. A committed dependency
change during rendering permits one fresh retry; another change forces a
no-store response, with private-on and removal still denied before return. Current-data facts resolve canonical misses without
a view; legacy address redirects keep their bounded lookup. Reuse the access and training
results within that request; do not repeat their database queries.

Structured facts and the public map take their title and optional summary
from the same approved view fields. They do not render or parse a complete
page to recover metadata. Home uses site.title/site.description, entries use
title/summary, and the combined archive uses its configured title without a
synthetic description. This intentionally replaces look-specific headings
and text-copy fallback descriptions. Escape inert JSON-LD as before; neither
facts nor map rows expose drafts, private cards, mention destinations or
unapproved fields. Preserve map links, ordering and 50-link/16 KiB bounds.

After the private gate, a path outside the engine's public route shapes gets
a tiny fixed 404 without loading a reader view. Session-bearing requests bypass
this shortcut so the owner link on rendered not-found pages remains intact.
This decision uses path shape,
not a lookup of whether a slug exists. A canonical route-shaped miss is a 404 from the current dependency facts,
without liveView, even with If-None-Match *. Existing aliases and historical
address redirects are checked before declaring a miss.

UC9 becomes best-effort buffered accounting of anonymous public GET 200
responses only. HEAD and 304 no longer increment counts. Keep only day, kind
and count in process/isolate memory, with no URL, UA, IP, credential or request
identifier. Flush aggregates in one bounded UPSERT at most once per minute;
Worker work uses waitUntil and the server uses equivalent background work.
Concurrent arrivals must not overwrite increments. Failed flushes retain the
bounded aggregates for retry, but process loss can lose unflushed counts;
this is an estimate, not durable per-request delivery. Owner reports disclose
the excluded HEAD/304 traffic, delayed visibility and possible loss. No flush
or accounting work belongs on a public conditional or HEAD request path.

Required paired proof: private/session gate before every conditional shortcut;
unknown paths and removed resources never 304; old tags fail after live,
training, theme, receipt, media or clock changes; actual previous-runtime
writes cannot leave a reusable stamp. Test direct/negotiated Markdown tag
identity, escaped metadata, map caps and 200-entry constant query cost, and
concurrent buffered increments/flush failures. Assert no more than three
D1 statements for a public 304 or unshaped 404, with zero liveView calls,
body hashes, prepared-copy accesses and accounting writes. Measure first
render 200 statement counts and compare them with the previous implementation.
Measure hosted public 304 and 404 CPU against the 10 ms target; local timings
are reported separately and are not hosted CPU evidence.

### PERF-2: render only consumed entry bodies

Both editions defer an entry's `body_html` until a template reads it. Building
home, stream, tag or entry view metadata must not parse unused entry Markdown.
Reuse the resulting HTML only within that request/view and the same heading
policy; no rendered body enters an isolate-wide, process-wide or shared cache.
The look's heading-ID and body-H1 policy applies on the first render, without
an eager ordinary render followed by a second parse. Preserve exact output,
engine embed provenance and limits, escaping, pipe tables and heading IDs.
An unselected body cannot mint embed capabilities or perform work merely
because the renderer walks metadata to apply policy or collect capabilities.

After the existing access gate, an anonymous public Markdown negotiation
renders the approved visitor HTML once before projecting it. Preserve direct
and negotiated copy bytes, normalized canonical URL, validators and headers;
private/session authorization and no-store policies remain unchanged. Neither
optimization changes approved content, dependency checks, accounting or access.

Required proof: unchanged bytes across all twelve looks and explicit embed,
table and heading fixtures; zero entry-body parses for metadata-only templates;
one parse for a consumed repeated body under one policy; no memo reuse across
requests or heading policies. Measure unconditional home and stream 200s on
the same 200-entry fixture against a local CPU target below 5 ms, reporting
local timing separately from hosted CPU. The real emitted Worker must start.
