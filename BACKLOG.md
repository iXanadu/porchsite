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
1. **PERF-6** OPEN: a cold public page still costs about 17-23 ms of CPU
   (typical, hosted, measured 2026-10-18 after PERF-5) against the free
   plan's 10 ms; repeat visits answered "not changed" are about 5 ms. Find
   where the time goes stage by stage, then cut the biggest costs.
   Measured locally (median 16 ms per cold GET /): checking and decoding
   the site data 22%, building the page from the theme 14%, setting up
   sign-in handling that a public page never uses 12%, garbage collection
   9%. Cuts, smallest first:
   - **PERF-6b** HELD: the same request checks the site data twice (when
     reading the facts and again for the page). Removing the middle check
     (branch at d962bfa, all correctness and parity checks pass) saved only
     about 0 to 1.2 ms (paired medians, 9 of 12 looks faster, 3 slower):
     the first and final checks are the real cost and must stay. Not worth
     touching validation for that; revisit only with a larger design.
   - **PERF-6c** OPEN (server edition): defer unused full-entry and
     highlight collections, preserving template consumption, escaping,
     heading policy, embed provenance and deep-check proof. The Worker
     now defers those two collections; local 200/500-entry paired medians
     improved 0.7–8.1 ms across three looks, while sample-site results
     were mixed. A server port needs its own measurement and approval.
2. **PERF-7** OPEN (round 2 profile, 2026-10-18, after PERF-6a/6c): a cold
   page on the 12 sample sites now costs 12.9-18.7 ms (typical, local);
   still all over 10 ms. Largest shares: checking and decoding site data
   25%, building the page 15%, memory clean-up 10%. A 500-entry
   event-heavy site costs about 57 ms. Cuts to measure, every check kept:
   - **PERF-7a** HELD (failed): the decode repeats scans and copies
     within one read. The scans and sorts are small and fixed-size; not
     copying already-ordered lists (branch 8513d21) made 500-entry sites
     8-12 ms SLOWER. Not shipped; do not retry without a new design.
   - **PERF-7c** HELD: reading the site facts as plain rows instead of
     one object per row (branch 4d966f1, all checks pass) was mixed on
     500-entry sites: services 1.6 ms faster, personal 0.4 ms slower. Not
     a clear win; not shipped.
3. **PERF-4b** HELD: the cost of storing a page on a first visit when
   PERF-4 is on (about 8 ms locally). Reusing the bytes already built
   (branch c596b06, all checks pass) saved only about 0.4 ms, mixed. Since
   PERF-4 is off by default, not worth shipping alone. The larger option,
   proving freshness with a narrower query, needs a spec and security
   review; revisit only if an owner enables PERF-4.

3. **GATE-2** OPEN (owner, 2026-10-18): every release states database
   rows read per request (cold page, plain page, "not changed"), before and
   after, with prepared copies off and on, plus the free daily-limit impact
   ("about N page views a day per account"). The release build measures it
   on the sample sites and refuses a release whose rows went up unless its
   changelog entry carries a written reason. Owner approves any increase
   before it is deployed. Decision briefings state reads, writes and limit
   impact, not only speed.

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
- **S4-7B** OPEN: an openable visual preview for the assistant. Requires
  owner consent per writer connection and a separately reviewed capability;
  the authenticated MCP inspection copy does not complete this browser goal.

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
  heading order). Facts, never advice. PARKED 2026-10-18 behind PERF-6:
  computing the facts on every check cost 4-25 ms against a 1 ms budget,
  and even checking per-item fingerprints on read cost 2-4 ms (up to
  about 13 ms on large sites). Next, when resumed: prove that every write
  path in every supported release changes each item's version marker; if
  so, compare markers on read and fingerprint only at write (both reviewers
  agreed to this, given complete marker lists and the audit); if not, check
  a bounded slice per call. Correctness reference: branch at f1bafb2.
Not now (watch): MCP server cards, WebMCP, NLWeb, signed agents, pay per
crawl, agents.json, ai.txt. No demonstrated consumers for small sites.

## OWNER REQUESTS (2026-10-16)
- **CO-1** OPEN (owner, 2026-10-18): a plain free/paid/self-host
  explanation for people and assistants. It covers the Cloudflare free
  plan's limits; what happens when a site goes over (it stops, with no
  bill, and one busy site can stop others on the same account); the risk
  of a paid plan (usage billing with no hard spending cap); how to move to
  a self-hosted server; and getting a small (about $5/month) server.
  Assistants tell every new owner before or during setup, and never
  upgrade a plan, add payment or turn on a paid feature without the
  owner's explicit yes. Lands on a porchsite.dev page, in the install
  guide, in the getting-started and helper flows, as a short block in the
  writer tools, in llms.txt/index.md, and on error pages. Staged for the
  owner's approval before anything goes live.
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
- **RA-10** OPEN: the recovery link uses the same `?code=` form that RA-9
  removes from setup links, so the code reaches request logs. Move it to
  the URL fragment the same way (one release still accepting the query,
  then refusing). Found 2026-10-18 in RA-9 review.
- **AN-1** OPEN: the visitor beacon (`POST /collect`) has no rate limit.
  Each accepted page-view event writes at least one database row and runs
  the retention clean-up (a delete plus an aggregate insert) every time.
  On the free plan, a flood of fake events uses up the 100,000 daily
  requests and writes, after which the site's own writes fail until the
  daily reset. On a paid plan it would raise the bill with no cap. Fix
  before any wider rollout: a cheap per-visitor or per-IP cap, and the
  clean-up run at most once per day instead of on every event. Found
  2026-10-18 on the owner's question.
- **DEP-2** OPEN: moving the agents package to its current major version
  changes the MCP runtime the Worker ships (it pulls a newer MCP server).
  Needs its own spec, security review and an MCP parity check; keep it
  separate from test-runner changes. Found 2026-10-18 in DEP-1 scoping.
- **AF-7T-C2** IN-PROGRESS (spec review): hosted on porchsite.dev (2026-10-18, e88698b),
  prepared copies cut a cold page to about 6.5 ms CPU (typical; it was
  about 21 ms), the first time under the free plan's 10 ms. But database
  rows read per cold page rose from 218 to 484, and "not changed" replies
  from 176 to 240. On the free plan's 5 million rows a day per account,
  that is about 10,000 cold page views a day instead of about 23,000.
  Cut the rows a copy's freshness check reads, keeping every check.
- **AF-7T-C1** OPEN: local prepared-copy HIT improves over live rendering,
  but fresh p95 below 10 ms, warm p95 below 5 ms and clean-MISS incremental
  CPU targets remain unmet on the 200-entry fixture. Keep default-off;
  hosted measurements and further profiling determine release settings.
  State-once transport and grouped-counts proof implemented 2026-10-18:
  12 fresh pairs gave HIT median/p95 10.27/13.55 ms and clean-MISS increment
  median/p95 3.74/7.70 ms. Facts JSON fell 65,178 to 46,427 bytes, but total
  HIT rows read only 3,480 to 3,472. The independent replication found the
  default-off path unchanged (+0.04 ms, inside noise, identical SQL); no
  target is declared met. A HIT still reads about 3,470 rows: that, not
  rendering, is what stands between it and 10 ms.
- **CF-S2** BLOCKED (Cloudflare): D1's binary RPC binding
  (`d1_binding_jsrpc`) could cut the Worker's memory per upload, but it is
  an experimental compatibility flag with no documented hosted
  availability (checked 2026-10-18), and binding still expands bytes to
  number arrays, so it is not zero-copy. Revisit when Cloudflare documents
  it as generally available.

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
