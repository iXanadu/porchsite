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

## STAGE 2 (2026-10-15): RA-10, P-2, SP-S2
Spec first, then both editions. One owner role per item; the reviewer
never reviews its own author's work; security reviews anything touching
uploads. Done when the full gate below is green on the exact revision,
review and security have passed it, and the full gate is green again on
the merged main tip. Gate (each exit code read on its own):
`cd cloudflare && npm test && npm run theme:check` and the typecheck;
`cd server && pytest -q`; `scripts/parity.sh`;
`scripts/conformance-server.sh`; `scripts/conformance-mutations.sh`;
`scripts/migration-check.py`; `scripts/upgrade-check.sh`.
- **S2-1** (RA-10) IN-PROGRESS: coder. Batch `image_add` as decided in
  RA-10 below. Tests: 8 files pass, 9 refused, over 32 MB refused, one bad
  file among good ones stores none. Measure the Cloudflare edition at the
  cap under local wrangler.
- **S2-2** (P-2) IN-PROGRESS: tester. `scripts/parity.sh` also runs each
  look's sample site through both editions' `site_check` and `site_state`
  and diffs the answers. Must fail on the stage 1 server URL defect
  replayed on purpose.
- **S2-3** (SP-S2) IN-PROGRESS: coder, after S2-1. Cap `site_check`'s
  crawl (pages and links), the same numbers in both editions, with the
  cap reported in the answer when it is hit.

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
- **RA-10** IN-PROGRESS (S2-1): Uploading many photos costs one tool call each (34+ in a
  reunion build). Decided (2026-10-15): several pictures per image_add
  call, behind the same owner auth; at most 8 files and 32 MB decoded per
  call; every file sniffed; stored by hash only (filenames ignored); all or
  nothing (any bad file stores none). The one-shot photo upload link stays
  one file. Many phone photos at once would be a signed-in owner page, a
  separate item if wanted. Check the Worker's memory at the cap first.
- **RA-8** IN-PROGRESS: Each harness at its best. Done: the assistant
  guide (by app), and Grok Bot's Porchsite template, public and linked.
  Left: a Porchsite setup for each other app (a Claude Project or Skill, a
  custom GPT, Meta AI's skills), then a run with each.

## DEGRADING
_(none)_

- **SP-S2** IN-PROGRESS (S2-3): `site_check`'s crawl has no page or link cap. A
  look with a huge local link fan-out burns CPU inside the owner's own
  check. Owner-authenticated only, not a visitor path. Found: stage 1
  security review.
- **SV-T1** OPEN: A server test run once failed its teardown (DROP
  DATABASE ... FORCE, privilege error) and left a `porchsite_test_*`
  database behind on the test cluster. Cause not yet known; seen once.

- **P-2** IN-PROGRESS (S2-2): Parity covers rendered pages only. The tools' answers
  (`site_check`, `site_state`) can differ between editions unnoticed: in
  stage 1 the server edition alone misjudged equivalent URLs and a
  base_url link. Run each look's sample site through both editions' tools
  and diff the answers as part of `scripts/parity.sh`.

- **SP-S3** OPEN: After SP-S1, the fixed part of `site_state` (guides,
  kinds, fields, defaults) is about 12.3 KB on every call, 86-96% of a
  sample site's summary answer (item summaries are 0.5-2 KB). Consider
  sending the fixed part once per session or on request. Measured on the
  ten sample sites in stage 1.

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
