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
_(none)_

## STAGE 3 (2026-10-15): fit the free plan's 10 ms CPU limit
Measured on a hosted test Worker on Workers Free (Observability
`cpuTimeMs`, 10 calls each): `site_check` 13/38/60 ms (min/median/max) on
release 2026.10.14-fbdd784 and 77/112/183 ms on main 90398c4; a trivial
tool call 14-49 ms. No call was cut off, but nothing may rely on that.
Goal: every request (public pages, the review pages, every tool) under
10 ms CPU on Free, with margin. Release held until a hosted re-measure
shows no call over 10 ms. Gate: the usual nine checks plus that
re-measure.
- **S3-1** IN-PROGRESS: tester. A local CPU check: each public page kind,
  each review page and each tool on every sample site, in local Wrangler
  with the inspector's CPU profile, warm and cold; a table per build, and
  a script others can rerun. Reproduce the hosted numbers' shape first.
- **S3-2** IN-PROGRESS: coder. Find and cut the per-request cost every
  call pays (a trivial tool call should cost a few ms). Profile first;
  report the top costs before changing anything.
- **S3-3** OPEN: coder, after S3-2. `site_check` works in steps: a per-call
  page budget, a `next` cursor to continue, and the same answer once all
  steps are done. Both editions, spec first. Find why main's check costs
  3x release fbdd784's first.
- **S3-4** OPEN: PM decision after S3-3's numbers. If the full check still
  can't fit, the deep crawl becomes an add-on that is off by default and
  marked as needing the paid plan, and the core keeps a quick check.

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

## DEGRADING
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
