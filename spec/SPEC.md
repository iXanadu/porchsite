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
picture) or `private` (it never shows). The rules, checked on every save
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
Status is 404; headers include `Cache-Control: private, no-store` and
`X-Robots-Tag: noindex`; there is no Location, beacon, site name or link.
GET and HEAD have matching status/headers (HEAD has no body). Check access
before constructing a live view, looking up media or resolving redirects.
This covers pages, misses, entries, tags, feeds, sitemap, search JSON, media,
share cards, old addresses, missing slashes and `/review` owner routes.
`/robots.txt` instead returns `User-agent: *\nDisallow: /\n`, without a
Sitemap line. Every gated response while private, including authorized
responses, errors and redirects, is `private, no-store`; conditional requests
never bypass authentication or reuse another actor's cached body.
Anonymous `/collect` requests make no analytics writes while private.

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
registration. Their pages use no-referrer/no-store headers and remove the
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
sessions and reader sessions; invalidate in-flight issuance by captured
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

One MCP endpoint per site, at `/mcp`, behind OAuth 2.1 (with Client ID
Metadata Documents, and Dynamic Client Registration for older clients).
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
that minimum and explains the exposure. The unauthenticated, no-store JSON
`GET /.well-known/porchsite-release` contains only `release` and
`private_floor` (null when public), never site content.

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

## Open questions

- Q1. Answered: yes. An assistant installs the Cloudflare edition into a
  person's own Cloudflare account through Cloudflare's MCP server or API,
  with no GitHub account (`cloudflare/INSTALL.md`).
- Q2. Which consumer assistants connect to a remote MCP server with OAuth
  today, and do any need an adapter?
