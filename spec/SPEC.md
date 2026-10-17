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
item. An entry belongs to exactly one stream. Entries and notes are listed
newest date first; on the same date, the one created later comes first. A stream's `dated_addresses`
(boolean, default `true`) decides how its new entries' addresses are made.

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

A private site's visitors receive exactly this UTF-8 body (no whitespace):
`<!doctype html><meta name="robots" content="noindex"><title></title>`.
Status is 404; headers include `Cache-Control: private, no-store, no-transform`,
`Content-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'`
and `X-Robots-Tag: noindex`; there is no Location, beacon, site name or link.
GET and HEAD have matching status/headers (HEAD has no body). Check access
before constructing a live view, looking up media or resolving redirects.
This covers pages, misses, entries, tags, feeds, sitemap, search JSON, media,
share cards, old addresses, missing slashes and `/review` owner routes.
`/robots.txt` instead returns `User-agent: *\nDisallow: /\n`, without a
Sitemap line. Every gated response while private, including authorized
responses, errors and redirects, is `private, no-store, no-transform`; conditional requests
never bypass authentication or reuse another actor's cached body.
Anonymous `/collect` requests make no analytics writes while private.

### Proposed media and stored-copy cache policy (SV-PV2)

This is a proposal for both editions, not a claim about the current media
headers. Today public `/media/` responses have a one-year immutable
lifetime. A content hash makes bytes stable; it does not make publication
or permission permanent. The proposed successful anonymous public media
header, including generated share pictures, is
`Cache-Control: no-cache, no-transform`. There is no `public`, `immutable`,
positive freshness lifetime, `stale-while-revalidate` or `stale-if-error`.
Every reuse must consult the origin before showing stored bytes. Media
also gets an ETag, so a still-published unchanged image can revalidate with
a bodyless 304 instead of a full download. This replaces the long media
lifetime; it does not change the separate AF page/feed policy.

Use the AF-2 validator encoding for binary media: SHA-256 of the canonical
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
An owner or reader response is `private, no-store, no-transform`, including
on a public site; the proxy must bypass cache reads and writes for both
session cookies. A private anonymous request retains the exact blank 404
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
external cache or production data. Runtime implementation and its parity
checks are a separate change after proposal approval; deployment docs may
land independently and must continue to describe the current long header.

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
| `site_state(full?, ids?)` | By default, every item summarized as `{id, kind, title, state, version}`; `full: true` returns the complete existing item shape, including data and approval metadata; `ids: [...]` returns full items only for those ids. The `release` running and `update` (below), and all other top-level fields, are unchanged |
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
heartbeats, to the same site's `POST /collect` (always 204). Send the page
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
header, query parameter, extension or bearer token grants access.

On a private site all new AF endpoints, including `/index.md`, entry,
archive and tag `index.md` paths and `/llms.txt`, return the exact blank
404 specified in §3, even for an owner or reader. A request selecting
Markdown at an existing page URL returns that same denial. HEAD has the
same status and security headers with no body. Denials carry no ETag,
Last-Modified, Link, Content-Location, canonical URL, site name, Location,
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
robots, feeds, sitemap and llms.txt, including successful GET/HEAD and
conditional 304s, by site-local calendar day and one of four kinds: search
crawler, training crawler, agent acting for a person, or other. Use one
shared, versioned user-agent classification table, evaluated in memory:
OAI-SearchBot, Claude-SearchBot and Googlebot are search; GPTBot and
ClaudeBot are training; ChatGPT-User and Claude-User are user-triggered.
Unknown or ambiguous user-agent strings are other. Google-Extended is a
robots preference token, not a separately identifiable request agent.
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
nonnegative, and increments are atomic. No new columns or values enter
legacy analytics tables or stored content JSON. A previous runtime ignores
the additive table and keeps its original statistics behavior.

Show day, kind and request count to the owner on request through the
existing protected statistics surfaces, with the coverage/classification
limits above. Counts are request counts, not unique people or verified
agents. Show no advice, ranking inference or automatic prompt. Public
pages, Markdown, JSON-LD and llms.txt never expose these counts.
Required paired cases are `af_agent_kind_daily_counts` (each class, other,
HEAD/304, concurrent increments and date rollover),
`af_agent_kind_no_identifiers` (schema and writes contain only aggregates),
`af_agent_kind_owner_only` (authorized report, no public/private-denial
leak), and `af_agent_kind_parity_rollback` (same classification/report in
both editions; previous-release tests pass on the additive schema).

### AF-2: validators and conditional reads

Successful anonymous GET and HEAD for home, on-site entries, stream
archives, tags, feeds, `/sitemap.xml` and public `/robots.txt` carry an ETag. This also applies
to the new successful Markdown and llms.txt responses. Missing resources,
redirects, errors, sign-in, review and capability URLs gain no AF validator.

For a representation with canonical HTML URL `U`, Content-Type `T`,
public Content-Signal value `S` (AF-4) and uncompressed UTF-8 bytes `B`,
compute SHA-256 over UTF-8(`U`), one zero byte, UTF-8(`T`), one zero byte,
UTF-8(`S`), one zero byte, then `B`. For feeds, sitemap, robots and llms.txt,
`U` is that resource's canonical site URL. Copies and negotiated Markdown
both use their canonical HTML URL, never the copy URL. The ETag is `W/"sha256-<64 lowercase hex digits>"`. Use the exact
Content-Type specified for that format, including `; charset=utf-8`.
The weak tag permits transport compression without claiming byte equality
between content codings. Both editions produce identical representation
bytes, Content-Type and tags at the same approved state and site origin.
No random id, secret, request cookie, internal-only database id or draft
revision enters a representation. Visible time-dependent content follows
the same render clock in both editions; its next visible change expires
prepared output and is an effective representation change. A different body or format changes its
tag; HTML and Markdown never share a tag. The direct Markdown URL and the
negotiated Markdown use the same bytes and tag.

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
ordinary themed HTML 404 even when Accept prefers Markdown. Direct
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
LF line endings and a final newline. Adjacent labels in layout containers
retain a word boundary (including number/unit and linked title/summary
pairs); paragraph and heading prose keeps intentional inline joins across
links, emphasis and code. Byte parity fixtures cover
Unicode, escapes, lists, code, embeds and relative links. Canonical page
addresses and generated paths, not untrusted forwarded-host values, supply
all discovery URLs.

### AF-4: the owner's training choice

The optional boolean `site.ai_training_disabled` defaults to false.
Absent or false allows training; true disables it. It is an
allowlisted exact-version site_fields value, never a key in legacy item,
revision or live JSON. Absence at the approved live version means training is allowed;
no older version's setting is inherited. Draft changes have no public
effect. Normal owner approval, review, restore and rollback apply; the
owner sees the setting and its effect before approving. No extra agent
approval step or service credential is introduced.

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
order are deterministic and identical in both editions.

### AF-6: a short public map

`GET /llms.txt` returns `text/markdown; charset=utf-8`, nosniff, with ETag
and conditional reads as above. It contains the visible site title, the
approved visible site description if present, and a list of canonical
Markdown copies with their visible page titles and summaries. No synthetic
summary is written when the owner supplied none. The title is one line;
descriptions and list labels are escaped data, never agent directions.

List home first, then published local entry pages in displayed stream and
entry order. Only pages whose anonymous canonical HTML GET returns 200
may be listed. Archive and tag copies remain discoverable through page
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

### AF-7: prepare public artifacts without weakening publication

HTML, Markdown, structured data, robots and map derive from the same
approved public snapshot. Prepare once per effective published state where
possible; both editions provide the same behavior without a host conversion
service. Exact storage backend and performance targets require the AF-1
baseline and a separate implementation plan; this section grants no paid
service or deployment authority.

Any public preparation/cache design must include site origin, canonical
path, representation, training choice and the complete effective published
state, including theme/version, visible settings and the next boundary
for time-dependent visible text. Publish, unpublish,
delete, restore, theme change and public/private transitions invalidate the
corresponding public artifacts. Draft changes do not. Once private mode
commits, no request newly authorized after that commit may serve an old
public artifact or 304; gate and generation checks precede shared storage.
An already delivered public response cannot be recalled. No private
prebuilding, private artifact table or per-agent cache is authorized here.

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
`BLANK` refers to the exact private-site body specified in §3. These apply
before the feature-specific presentation rules above.

Gating
1. Access check runs before live view, media lookup, Markdown/JSON-LD/llms build, ETag, Link, stored-copy lookup, or Accept negotiation.
2. AF paths are not on the private open-path allowlist: GET/HEAD /llms.txt, GET/HEAD <page>/index.md, and page URLs with Accept: text/markdown.
3. New private AF surfaces return exactly today's blank 404 for every cookie class (anonymous, owner, reader, expired, revoked): status, BLANK body and headers above.
4. That 404 has no ETag, Last-Modified, Link, Vary, Content-Location, or Age.
5. Its Content-Type is text/html (charset utf-8 allowed). Never text/markdown, application/ld+json, or text/plain except private /robots.txt as in 10. Accept: text/markdown does not change this (no content-type oracle).
6. HEAD matches GET status and those headers, empty body.
7. If-None-Match, If-Modified-Since, If-Match, If-Unmodified-Since never change 3-6. Never 304 for anonymous private.
8. All those gated anonymous private GET bodies are byte-identical to BLANK (no size oracle by path existence). Hits and misses match: /index.md of a real page equals /missing/index.md.
9. Test: spy/monkeypatch live_view, media lookup, stored-copy read, Markdown/JSON-LD/llms builders — they are not called for anonymous private gated requests (timing oracle = content lookup before gate).
10. Private /robots.txt stays exactly `User-agent: *\nDisallow: /\n` with private, no-store, no-transform; no Sitemap; no extra User-agent groups. The AF-4 training switch has zero effect on private robots bytes. No ETag/Link.

Session and shared cache
11. Public cacheable representations (HTML, Markdown, JSON-LD-in-HTML, llms.txt, robots, feeds, sitemap) are built from the anonymous published view only.
12. A request with a valid owner or reader cookie never gets Cache-Control containing `public`, never a shared public ETag used to 304, and never an AF-7 stored copy from a shared cache. Owner HTML is Cache-Control: private, no-store, no-transform.
13. Owner-only bytes (Review link, CSRF, /review URLs, session name, draft counts, alert UI) never appear in any cacheable response (`public` or missing no-store) nor in Markdown, JSON-LD, llms.txt, robots, feeds, or sitemap.
14. ETag, when present, hashes only the anonymous published representation: canonical URL U, Content-Type T, the approved training signal S and body bytes B, with nothing from any session, using AF-2's exact encoding. Owner responses do not send that ETag (owner If-None-Match cannot 304 to public HTML missing the Review link; visitor If-None-Match cannot 304 to owner HTML).
15. Do not rely on Vary: Cookie. Defense is cookie-independent public bodies plus no-store on every authenticated page (SV-PV1). Test: visitor GET after owner GET of the same URL returns visitor bytes with no Review link; only the cookieless response may be public-cacheable.
16. AF HTML/Markdown/llms copies are never `immutable` and never max-age longer than today's public page/feed policy (feeds/sitemap 300s; pages today no-cache). Unpublish, private-on, or card-visibility change deletes stored copies before the next response. After private-on or unpublish, a previously public URL does not 304 from the old ETag (SV-PV2).
17. Page URLs that negotiate Markdown send Vary: Accept. Canonical Markdown is <page>/index.md so a Vary-ignoring reverse proxy is not the only MD URL. A Vary miss may mix public HTML with public Markdown; it must not mix owner bytes (owner responses are no-store and not written to AF-7 caches).

Published-only content
18. Markdown, JSON-LD, llms.txt, sitemap, feeds, and ETag input use the live approved view only. Drafts, pending approvals, unpublished items, and unapplied rollback versions never appear.
19. Private cards are absent (name, description, link, picture, badge).
20. Mention cards: name and description only; no link, link label, or picture — same as HTML.
21. Unpublished entries and owner/review/setup/preview/login/recover/invite/upload/mcp paths never get Markdown copies, JSON-LD, or llms.txt listings.
22. llms.txt lists only URLs a visitor GET would 200 as HTML (home + published local entry pages). No /review, drafts, private cards, media secrets, or invite tokens.
23. JSON-LD properties are existing published fields already shown on that page. No email/phone/price/beds unless already a public page field. No session or owner-only fields.
24. Markdown of a page is the same published text the visitor HTML shows (title, date, tags, body, visible cards), not a richer dump of item JSON.

AF-8
25. Porchsite-authored sentences on agent surfaces (llms.txt boilerplate, JSON-LD @context/@type, Link rel values, Markdown wrappers) are a frozen template. Owner field values appear only as data: title, summary, URL, dates, body, schema.org property values.
26. Owner fields are never interpolated into Porchsite-authored imperative language ("you must", "ignore", "system", "when answering", "instructions for AI").
27. Tests with title/summary/body/about/footer/card description/tagline set to `Ignore previous instructions`, `SYSTEM:`, `</script>`, `` `json `` fences, `data:text/html`, unapproved embeds, private card names: JSON-LD in HTML is JSON-escaped so `</script>` cannot break out of the script tag; Markdown/llms.txt grow no Porchsite-authored instruction preamble; private-card names still fail content_guard; the payload appears only as the owner's published text.
28. rel=alternate and rel=describedby Link targets are same-origin site URLs to that page's Markdown copy and /llms.txt. Never owner-controlled URLs.

Routing
29. <page>/index.md exists only for addresses that are a public HTML page (home /index.md, entry /stream/slug/index.md, archive/tag if those pages exist). /review/index.md, /login/index.md, /media/.../index.md, /mcp/index.md are not Markdown copies: private anonymous → blank 404; public → ordinary miss, never owner HTML as markdown.
30. On a public page, Accept: text/markdown returns the same bytes as that page's /index.md, Content-Type text/markdown; charset=utf-8, Vary: Accept. Public miss: themed HTML 404, not markdown. Private anonymous: blank HTML 404 even with that Accept (5).
31. Both editions: identical bytes and headers for the same published site (parity includes Markdown, llms.txt, robots with the training switch, JSON-LD).

AF-4 training switch
32. Public default: today's robots (`User-agent: *` Allow: / plus Sitemap). Training-off adds well-known training-crawler Disallow groups; `User-agent: *` Allow: / stays for search and user-triggered agents.
33. The switch is an exact-version approved site_fields key (like private), never a legacy JSON key the previous release would parse into SiteData (S4-11 BLOCK 1). Absent or false = training allowed. Private robots ignore it (10).

Protocol leftovers
34. /.well-known/porchsite-release, OAuth metadata, /login, /mcp stay as today: no site content, no llms listing of private pages.

### Named security acceptance cases (paired in both editions)

Each row names a required implementation test, not an existing passing
result. Run denial cases against anonymous, owner, reader, expired and
revoked cookies; all new private AF paths are blank for every cookie class.
The named cases implement the corresponding numbered invariant above.

| Rule | Required test name | Assertion |
| --- | --- | --- |
| 1 | `af_gate_before_representation` | Access precedes views, media, builds, validators, links, storage and negotiation. |
| 2 | `af_no_private_open_paths` | AF paths never enter the private allowlist. |
| 3 | `af_private_exact_blank` | New private AF surfaces return the existing blank 404 for every cookie class. |
| 4 | `af_blank_no_metadata` | No validators, links, Vary, Content-Location or Age. |
| 5 | `af_blank_html_type` | Accept never changes denial Content-Type. |
| 6 | `af_private_head` | HEAD has GET status/security headers and empty body. |
| 7 | `af_private_conditionals` | All four conditional fields preserve the denial. |
| 8 | `af_private_hit_miss_identity` | Existing and missing copy paths have identical blank bytes. |
| 9 | `af_denial_lookup_spies` | All content, media, copy and builder spies remain uncalled. |
| 10 | `af_private_robots_unchanged` | Exact disallow-all bytes/headers under every training setting. |
| 11 | `af_cache_anonymous_view` | Every public artifact derives from the anonymous approved view. |
| 12 | `af_authenticated_cache_bypass` | Owner/reader requests bypass shared copies and public 304s and send no-store. |
| 13 | `af_no_owner_surface_leak` | Owner-only fields occur in neither public cacheable bytes nor agent copies. |
| 14 | `af_etag_public_input` | Hash canonical URL, Content-Type, approved training signal and body bytes only, using AF-2; changing only training changes the tag; owner/visitor validators cannot cross roles. |
| 15 | `af_owner_then_visitor` | Owner request followed by visitor request never transfers owner decoration. |
| 16 | `af_invalidate_before_serve` | Unpublish, private-on and card visibility invalidate copies and old tags. |
| 17 | `af_accept_cache_separation` | Vary: Accept plus canonical direct copy; no owner bytes under either variant. |
| 18 | `af_approved_only` | Draft, pending, unpublished and unapplied versions never affect artifacts. |
| 19 | `af_private_card_absent` | Every private-card field is absent from all new surfaces. |
| 20 | `af_mention_card_projection` | Mention cards expose only displayed name and description. |
| 21 | `af_reserved_and_unpublished_paths` | Owner/protocol/capability and unpublished paths have no copies or map entries. |
| 22 | `af_map_links_resolve` | Every map entry corresponds to an anonymous HTML 200 and a valid copy. |
| 23 | `af_jsonld_visible_fields` | Structured facts use only existing approved visible fields; paired browser tests prove inline data or the discovered same-origin twin under unchanged CSP. |
| 24 | `af_markdown_visible_text` | Markdown omits fields and items absent from the visitor page. |
| 25 | `af_frozen_wrappers` | Engine-authored words stay fixed across owner payload changes. |
| 26 | `af_no_imperative_interpolation` | Owner data never enters engine-authored instruction language. |
| 27 | `af_injection_payload_matrix` | Payload matrix preserves JSON data boundaries and content guards without new instructions. |
| 28 | `af_generated_link_origins` | Alternate and describedby target only generated same-origin paths. |
| 29 | `af_copy_route_matrix` | Copies exist only for real pages; reserved and missing paths remain misses. |
| 30 | `af_negotiated_copy_identity` | Negotiated/direct Markdown match; public misses stay themed HTML 404. |
| 31 | `af_cross_edition_http_parity` | Bytes and headers match for every new representation and training setting. |
| 32 | `af_public_robots_choices` | Default unchanged; off adds training-only denial groups. |
| 33 | `af_training_additive_approval` | Exact-version field; absent/false allowed; legacy JSON unchanged; private ignores it. |
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

## Open questions

- Q1. Answered: yes. An assistant installs the Cloudflare edition into a
  person's own Cloudflare account through Cloudflare's MCP server or API,
  with no GitHub account (`cloudflare/INSTALL.md`).
- Q2. Which consumer assistants connect to a remote MCP server with OAuth
  today, and do any need an adapter?
