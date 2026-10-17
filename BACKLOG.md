# Porchsite: BACKLOG (open items only)

> The single source of truth for deferred work. Read it every session;
> update it the moment a defect is found or resolved. Done = DELETE the line
> in the same commit as the fix. This repo is public: generic wording
> only.

## Triage
- **BLOCKING**: breaks the build, wrong or harmful output, data loss. Fix now.
- **DEGRADING**: still works. File it and keep moving.

Prefixes: `CF-` Cloudflare edition, `SV-` server edition, `TH-` themes,
`SP-` spec, `P-` the two-edition plan. Status: OPEN / IN-PROGRESS / BLOCKED.

## NOW (sprint 2026-10-17, in order)
1. AF-2..AF-8 and UC9, built in slices on branch `af-integration` (kept off
   main until their release, because INSTALL.md and llms.txt are read raw
   from main). Then ST-1..ST-3, rebased onto AF, with AF handling for
   /archive/. Then SV-PV2 (media header). AG-* last.

## BLOCKING

## STAGE 4 (2026-10-15, after S3-6/S3-7): what a real listing site needs
Found building a single-property listing site on the live release.
- **S4-2** OPEN: Many photos from the owner's phone at once. An assistant
  without a code runner can't send 40 photos (base64 in a tool call is
  about 16 MB of text). A signed-in owner page that takes many photos,
  shrinks each in the browser (S3-6 rules), strips location (S3-7) and
  tells the assistant the stored paths. Security review first.
- **S4-4B** OPEN (only when asked, after browser push ships and is tested):
  approval alerts by email for the server edition and owners using their
  own domain. No paid mail-service path for hosted default-domain owners.
- **S4-7** OPEN: The assistant can't see what it built before the owner
  approves: no preview it can open. Design with security (a short-lived
  read-only preview for the assistant).

- **S4-10** OPEN (designed 2026-10-16): most newer-format requests already
  take the Cloudflare fast path; the SDK still handles the 2026-07-28 format
  and requests with extras (_meta, initialize capabilities, ping,
  notifications/initialized). Step 1: log which path each /mcp request takes
  (path, fallback reason, method, version, app's public name; never the
  owner's label, tokens or params). Step 2: widen the fast path only for
  shapes proven byte-identical to the SDK on a shared fixture set. The
  server edition has no fast path; add one only if its timings call for it.
  No reconnect.
- **RA-11** OPEN: One clean Claude run in the plain Claude chat app (no
  browser extension, only the two source files), to settle whether a
  non-technical owner gets through with Claude at all. Round 3's Claude run
  is invalid: it was given the wrong files.
- **RA-9** OPEN: The install guide's setup code as a hashed row in the
  site's database (as the installer does), not a Worker secret: no secret
  to delete after the claim, one step fewer, nothing for the audit check.
- **RA-8** IN-PROGRESS: Each harness at its best. Done: the assistant
  guide (by app), and Grok Bot's Porchsite template, public and linked.
  Left: a Porchsite setup for each other app (a Claude Project or Skill, a
  custom GPT, Meta AI's skills), then a run with each.

## AGENT-FRIENDLY PUBLIC SITES (owner's business case, 2026-10-17)
Goal: every site is easy, quick and cheap for AI agents to read, on either
edition, without exposing anything an agent shouldn't see. Rules: nothing
may depend on Cloudflare (each item passes on both editions); friendliness
never widens access (on a private site every new path returns today's blank
404); no traffic or ranking claims to owners, only "cheaper and easier for
agents to read". Spec first (one SPEC.md section for AF-2..AF-8), with
security invariants written before the spec.
- **AF-1** OPEN (first): measure before building. A local baseline on the
  sample sites (bytes and headers per page type, whether repeat fetches get
  a 304). Then an owner-readable count of traffic by kind: search
  crawlers, training crawlers, agents acting for a person. On request
  only, as facts.
- **AF-5** OPEN: schema.org JSON-LD in every look, from existing fields
  only, matching what the page shows (was AI-2, Listing and Local business
  only). Structured listing facts (price, beds) would need fields stored
  where the previous release never reads them (see S4-11).
- **AF-7** OPEN: build-ahead for public pages (was S4-9). Hosted CPU on
  Free is about 2-3x local, so even a warm home page costs 9-14 ms. Serve
  stored copies of public pages, Markdown copies and llms.txt, cleared on
  every change; Workers Caching first, the site's own table if that can't
  be switched on through the API upload, and the server edition's
  equivalent. Also takes page views off the free plan's daily read limit.
- **AF-8** IN-PROGRESS (Markdown and map boundary complete; JSON-LD remains): anything published for agents (Markdown, JSON-LD,
  llms.txt) comes only from the owner's approved content and never carries
  instructions aimed at agents. A spec rule plus tests.
- **AI-3** OPEN: site_check reports AI-reader facts on request (photos
  without alt text, embeds without a caption, pages without a description,
  heading order). Facts, never advice.
- **AI-5** OPEN (decided 2026-10-16: capability facts only, no coaching;
  Porchsite stays passive): a short block in the tool descriptions saying
  what Porchsite builds, which look suits whom and how approval works.
Not now (watch): MCP server cards, WebMCP, NLWeb, signed agents, pay per
crawl, agents.json, ai.txt. No demonstrated consumers for small sites.

## AGENT ACCESS TO PRIVATE SITES (LAST, after the public work)
People read a private site through passkeys; agents can't and shouldn't.
Use: the owner's own agents read the private playbook to check it matches
the owner's records (the records are the truth; agents read, they never
write there). Any agent holding access gets the same light versions
cheaply and may keep its own private copy; nothing private is ever stored
in a shared cache or shared place; anonymous visitors see no change.
- **AG-1** OPEN: read-only assistant keys. At /review/assistants the owner
  ticks "Read only" when making a key, with a "published pages only" scope
  (never drafts, history or stats) for checking agents. The key may call
  site_state, site_check and the AG-2 tools, and nothing that drafts.
  Listed with last use; one key per agent. Both editions; security review
  first. Today every key can also draft.
- **AG-2** OPEN: lighter read tools over /mcp: `page_get(path)` (one
  published page as Markdown with title, date, tags and canonical URL),
  `pages_list(stream?, tag?, since?)` (paths, titles, change dates) and
  `search(query)`. site_state returns the whole site at once.
- **AG-3** OPEN: agent readers for agents the owner trusts that aren't the
  owner's own: a named published-only key in a NEW table, apart from
  assistant keys and reader passkeys; revoking is immediate and logged.
  May fold into AG-1's published-only scope.
- **AG-4** OPEN: AF-3's Markdown copies on a private site with
  `Authorization: Bearer <AG-1 or AG-3 key>` (never in the URL); `private`
  caching with an ETag for that agent only; without a key, the same blank
  404.
- **AG-5** OPEN: on a private site, llms.txt sits behind the gate too;
  anonymous agents learn nothing beyond the blank page.
- **AG-6** OPEN: owner review pages give a signed-in agent the same light
  versions, protected like any other private data; no separate owner
  review step (the owner approves content once).

## OWNER REQUESTS (2026-10-16)
- **DR-1** IN-PROGRESS: sprint reports live on fleet.c52.com (the owner's
  one private playbook), one "<Project> reports" stream per project, no
  expiry, weekly batch approval. Changed 2026-10-17: all updates to the
  playbook go through the owner's one always-on assistant; PMs send their
  report there instead of filing drafts, so no per-PM write key. No new
  engine code.
- **ST-1** OPEN (medium): a site allows at most 8 streams (`streams`
  max 8 in both editions' models). The fleet playbook wanted 9 guide Parts
  plus a report stream per project and had to merge them. Raising the cap
  is a compatibility change: the previous release validates the stored site
  item strictly, so a site saved with more streams may fail on rollback.
  Needs the additive pattern (extra streams outside the legacy JSON, or a
  release floor like private mode) and an upgrade-check case. Found
  2026-10-16.
- **ST-2** OPEN: one archive of all entries by date across streams,
  filterable by tag (for reports sortable by project or by date as a
  reader's choice). Found 2026-10-17.
- **ST-3** OPEN: a stream chooses its sort order (date or title).
  Found 2026-10-17.
- **PB-2** OPEN (when needed): playbook look option to show the latest N
  entries per stream on the contents page, with an "All →" link, so report
  diaries don't crowd the home page.
- **MD-1** OPEN (medium): pipe tables (GitHub style) in the Markdown
  renderer, both editions, proven identical. Playbook reference pages use
  "Term: meaning" lists until then.

## DEGRADING
- **AF-C1** OPEN: an older release approving a version written by newer
  code approves every site_fields key, so it can switch on the AI-training
  choice without showing it (same class as the broker fields). Needs the
  receipt pattern private mode uses. Found in AF Slice1 review, 2026-10-17.
- **SV-PV2** OPEN: a caching reverse proxy in front of a server-edition
  site keeps serving /media files the site no longer publishes: the site
  sends `public, max-age=31536000, immutable`. Deploy guidance now disables
  proxy media caching and stale responses, bypasses both session cookies
  and requires purging old copies. Remaining: review and implement a
  shorter origin media header in both editions, coordinated with AF cache
  invalidation. Found 2026-10-16.
- **REL-1** OPEN: the release script refuses a changed look whose version
  wasn't bumped, but only at release time. Move that check into the
  regular gates (theme:check). Found 2026-10-16.
- **PV-4** OPEN: after owner recovery, tell the owner to review their
  readers (a reader enrolled from a stolen owner device keeps a working
  passkey). Recovery already cancels unused invites. Found in review,
  2026-10-16.
- **SP-S4** OPEN: Listing sites (hundreds of entries) will meet
  `site_check`'s crawl cap and the free plan's CPU limit. Needs a design
  that scales (for example, reachability from the archive's own listing
  without rendering every page). Before the listing-site build.
- **SP-S3** OPEN: After SP-S1, the fixed part of `site_state` (guides,
  kinds, fields, defaults) is about 12.3 KB on every call, 86-96% of a
  sample site's summary answer (item summaries are 0.5-2 KB). Consider
  sending the fixed part once per session or on request. Measured on the
  ten sample sites in stage 1.
- **CF-S2** OPEN: D1's binary RPC binding (`d1_binding_jsrpc`) could
  cut the Worker's memory per upload (the JSON path adds about 2x the
  decoded size at serialization). Would allow a larger image_add batch.
  Needs its own security review.
- **CF-M1** OPEN: One 8 MB picture through image_add peaks at about
  98 MiB in the Worker (measured locally, fresh isolate), about 23%
  under the 128 MiB limit. Consider a lower per-file limit or a leaner
  decode and D1 path (see CF-S2). Found: stage 2 memory measurement.

## STRATEGIC
- **CF-S1** IN-PROGRESS: Install without a git account: guide and bundle
  live, with the audit-log check; left: another run on a fresh Cloudflare
  account.
- **SP-C1** OPEN: Publish `spec/conformance/check.py` as a package (with
  the public repo).
- **SP-T2** OPEN: Template contribution by pull request (needs the public
  repo).
- **SP-Q2** OPEN: Which consumer assistants connect over remote MCP with
  OAuth; mark each tested or untested.
  Tested so far: Grok and Claude install and connect. Meta's assistant
  installed only through Cloudflare's MCP (its egress then blocked
  api.cloudflare.com) and its hosted connector never registered with the
  site, so it connected by a hand-pasted code. OpenAI's assistant failed at
  the Cloudflare step (cause not yet known). Docs say ChatGPT custom
  connectors get write tools only on some plans.
