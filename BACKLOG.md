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

## BLOCKING

## STAGE 4 (2026-10-15, after S3-6/S3-7): what a real listing site needs
Found building a single-property listing site on the live release.
- **S4-2** OPEN: Many photos from the owner's phone at once. An assistant
  without a code runner can't send 40 photos (base64 in a tool call is
  about 16 MB of text). A signed-in owner page that takes many photos,
  shrinks each in the browser (S3-6 rules), strips location (S3-7) and
  tells the assistant the stored paths. Security review first.
- **S4-4** OPEN: Owner told promptly and privately when an approval is
  waiting, not only through a link the assistant passes on. Design first
  (browser push to the owner's signed-in device, or email), owner picks.
- **S4-7** OPEN: The assistant can't see what it built before the owner
  approves: no preview it can open. Design with security (a short-lived
  read-only preview for the assistant).

- **S4-9** OPEN: Build-ahead for public pages (the stage 3 goal that
  tuning couldn't reach: hosted CPU on Free is about 2-3x local, so even a
  warm home page costs 9-14 ms). Serve stored copies of public pages and
  clear them on every change; Cloudflare Workers Caching first (stored
  hits use no CPU), the site's own table if that can't be switched on
  through the API upload. Also takes page views off the free plan's daily
  database-read limit. Owner decides after the plan.
- **S4-10** OPEN: The assistant connection's newer message format (what
  real connectors send) still takes the slow library path: 13-64 ms per
  request hosted. Log which path each connector uses, then give that
  format the same fast path, proven byte-identical.

## READY FOR ASSISTANTS (a four-assistant install test, 2026-10-12)
Porchsite works end to end for an assistant built like the one it was
developed with (own machine, open network, a local file passed into a tool
call). Consumer assistants broke on network blocks, the 1.6 MB upload, the
site's OAuth connector, and pictures held as files. In order:
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

## AI READERS AND ASSISTANT GUIDANCE (owner's request, 2026-10-15; after the Listing look)
- **AI-2** OPEN: JSON-LD for the Listing and Local business looks, from
  existing fields only; built and stored with build-ahead (S4-9), never per
  request. Structured listing facts (price, beds) would need fields stored
  where the previous release never reads them (see S4-11).
- **AI-3** OPEN: site_check reports AI-reader facts on request (photos
  without alt text, embeds without a caption, pages without a description,
  heading order). Facts, never advice.
- **AI-4** OPEN: per-site `/llms.txt` and a stored Markdown copy of each
  page, built with build-ahead (S4-9).
- **AI-5** OPEN (decided 2026-10-16: capability facts only, no coaching;
  Porchsite stays passive): a short block in the tool descriptions saying
  what Porchsite builds, which look suits whom and how approval works.

## OWNER REQUESTS (2026-10-16)
- **DR-1** IN-PROGRESS: sprint reports live on fleet.c52.com (the owner's
  one private playbook), one "<Project> reports" stream per project, no
  expiry, weekly batch approval; PMs file drafts at wrap-up (admin owns the
  shared wrap-up step). No new engine code. A separate reports site was
  tried and removed the same day.
- **ST-1** OPEN (medium): a site allows at most 8 streams (`streams`
  max 8 in both editions' models). The fleet playbook wanted 9 guide Parts
  plus a report stream per project and had to merge them. Raising the cap
  is a compatibility change: the previous release validates the stored site
  item strictly, so a site saved with more streams may fail on rollback.
  Needs the additive pattern (extra streams outside the legacy JSON, or a
  release floor like private mode) and an upgrade-check case. Found
  2026-10-16.
- **PB-2** OPEN (when needed): playbook look option to show the latest N
  entries per stream on the contents page, with an "All →" link, so report
  diaries don't crowd the home page.
- **MD-1** OPEN (medium): pipe tables (GitHub style) in the Markdown
  renderer, both editions, proven identical. Playbook reference pages use
  "Term: meaning" lists until then.

## DEGRADING
- **SV-PV2** OPEN: a caching reverse proxy in front of a server-edition
  site keeps serving /media files the site no longer publishes: the site
  sends `public, max-age=31536000, immutable`, and a serve-stale proxy keeps
  the old copy after the origin answers 404. Found when a GPS-tagged photo
  stayed public after the cleanup (purged by hand, 2026-10-16). Fix in the
  deploy guidance (do not cache /media longer than pages, never serve
  stale for 404) and consider a shorter media cache header. With SV-PV1.
- **SV-PV1** OPEN: a server-edition site behind a caching reverse proxy
  must bypass the cache for the reader cookie (`__Host-sk_reader`) as it
  does for the owner's, before private mode is turned on. Document it in
  the server deploy guide and the self-hosting notes. Found 2026-10-16.
- **REL-1** OPEN: the release script refuses a changed look whose version
  wasn't bumped, but only at release time. Move that check into the
  regular gates (theme:check). Found 2026-10-16.
- **PV-4** OPEN: after owner recovery, tell the owner to review their
  readers (a reader enrolled from a stolen owner device keeps a working
  passkey). Recovery already cancels unused invites. Found in review,
  2026-10-16.
- **PH-1** OPEN: photos stored before release 2026.10.16 still carry their
  location metadata. Build an owner-approved, reversible cleanup that
  re-stores them without it, plus a changelog note. First after the passkey release.
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
