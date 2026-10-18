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

## NOW (sprint 2026-10-17, in order; owner: performance first)
1. Measure the hosted first build after PERF-5 (5 database reads instead
   of 11). Cold renders were about 17 ms typical on the free plan's 10 ms
   budget before it.
2. PERF-4: reuse a rendered public page for every visitor in a location
   while nothing on it has changed.

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
- **AF-7H** OPEN: hosted CPU and database-read/write measurement before
  default enablement of prepared public pages. The D1/PostgreSQL backend is
  operator opt-in and remains off by default. Local process CPU is diagnostic;
  it does not establish hosted savings or lower database cost. Resolve the
  local large-site entry p95 regression before considering default enablement.
- **AI-3** OPEN: site_check reports AI-reader facts on request (photos
  without alt text, embeds without a caption, pages without a description,
  heading order). Facts, never advice.
- **AI-5** OPEN (decided 2026-10-16: capability facts only, no coaching;
  Porchsite stays passive): a short block in the tool descriptions saying
  what Porchsite builds, which look suits whom and how approval works.
Not now (watch): MCP server cards, WebMCP, NLWeb, signed agents, pay per
crawl, agents.json, ai.txt. No demonstrated consumers for small sites.

## OWNER REQUESTS (2026-10-16)
- **DR-1** IN-PROGRESS: sprint reports live on fleet.c52.com (the owner's
  one private playbook), one "<Project> reports" stream per project, no
  expiry, weekly batch approval. Changed 2026-10-17: all updates to the
  playbook go through the owner's one always-on assistant; PMs send their
  report there instead of filing drafts, so no per-PM write key. No new
  engine code.
- **PB-2** OPEN (when needed): playbook look option to show the latest N
  entries per stream on the contents page, with an "All →" link, so report
  diaries don't crowd the home page.

## DEGRADING
- **AG-R1** OPEN: an agent's read (site_state, page reads) that happens to
  straddle a minute boundary fails with cursor_stale even when the agent
  sent no cursor. A cursorless read should rebuild once and answer. Seen
  in the rollback check and an earlier acceptance run. Found 2026-10-18.
- **DEP-1** OPEN: npm audit reports 8 high-severity advisories in
  inherited dependencies (the MCP SDK, agents, and the test, build and
  local-runtime chain). Security review decides which ship in the Worker
  and are reachable; any that are become BLOCKING. Found 2026-10-18.
- **AR-1** OPEN: /archive/ filter parity gap. The Cloudflare edition's
  filter check accepts a decoded trailing newline in tag/stream (JS `$`)
  where the server edition refuses it, so the two editions answer a
  malformed filter differently. Not an access issue. Anchor the check to
  the exact end in both editions, with a paired test. Found 2026-10-17.
- **PV-4** OPEN: after owner recovery, tell the owner to review their
  readers (a reader enrolled from a stolen owner device keeps a working
  passkey). Recovery already cancels unused invites. Found in review,
  2026-10-16.
- **SP-S4** OPEN: Listing sites (hundreds of entries) will meet
  `site_check`'s crawl cap and the free plan's CPU limit. Needs a design
  that scales (for example, reachability from the archive's own listing
  without rendering every page). Before the listing-site build.
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
