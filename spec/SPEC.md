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
  `http://`, `https://`, `mailto:`, `/…` or `#…` addresses, anything else
  stays text; images only to the site's own `/media/` files (any other
  image renders as a plain link, or as text).

Templates decide how kinds look, never what they say (see §6).

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
| `site_state` | Every item with its id, kind, version and data; what's live vs draft; the `release` running and `update` (below) |
| `item_create(kind, data, idempotency_key)` | New item (S4) |
| `item_update(id, version, data)` | Change fields (S3) |
| `item_remove(id, version)` | Remove (recoverable, S5) |
| `item_history(id)` | Every version, who made it, why |
| `item_rollback(id, to_version, version)` | Stage an earlier version as a new one |
| `approval_request(ids, note)` | Ask the owner; returns a review link (S1, S2) |
| `approval_status(approval_id?)` | `pending` / `published` / `changes_requested` (with the owner's note) / `denied` / `superseded` |
| `image_add(data)` | A picture the assistant holds as a file, sent as base64 (JPEG, PNG or WebP, up to 8 MB): stored like any picture (S7), private until a published item uses it; returns its `/media` path and pixel size |
| `site_check` | The site as it will be once everything staged is published, looked over as a visitor clicks through it: `broken` (links inside the site that lead to no page, no home-page section with anything in it, or no stored picture; each with where it is and why) and `empty_sections` (sections in the layout with nothing in them); `ok` when neither. Read-only; run before asking for approval |
| `site_stats(days?, content_id?, src?, post?, include_test?)` | Visitor numbers (§8), read-only |
| `theme_list` | The site's look: current, installed, the catalog (each credited look with its maker's `author_x`), this site's theme requests and shared looks (each shared look's status, the curator's note, and `credit`: waiting, credited or not credited, when it claimed credit) |
| `theme_submit(name, note, author_x?)` | Share a look this site made with the review queue, only with the person's yes. `author_x`: the maker's X handle (no @), the only credit there is; the answer's `credit` carries a one-time claim code and the words to post on X from that account (TEMPLATES §3c) |

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
heartbeats, to the same site's `POST /collect` (always 204):

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
