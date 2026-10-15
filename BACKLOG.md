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

## STAGE 1 (2026-10-15): RA-6 and SP-S1
Spec first, then both editions. Each item has one owner role: coder
builds, tester runs the gate, reviewer reads the diff. Done when the gate
is green and the reviewer has approved, judged from the shown output.
Gate (each command's exit code read on its own, never through a pipe):
`cd cloudflare && npm test && npm run theme:check` and the typecheck;
`cd server && pytest -q`; `scripts/parity.sh`;
`scripts/conformance-server.sh`; `scripts/conformance-mutations.sh`;
`scripts/migration-check.py`; `scripts/upgrade-check.sh`.
- **S1-1** (RA-6) IN-PROGRESS: spec + both editions. `site_check` gains
  `unreachable`: published entries no visitor can reach from the home page
  as the site's own look renders it, each with its id and why. A test look
  that drops entries must fail the check in both editions.
- **S1-2** (SP-S1) IN-PROGRESS: spec + both editions. `site_state` returns
  a summary by default (id, kind, title, state, version per item; release
  and update unchanged). Full data comes back with `full: true`, or with
  `ids: [...]` for just those items. Additive only: nothing removed from the
  full shape. Measure the summary on each look's sample site and put the
  sizes in the commit message.

## READY FOR ASSISTANTS (a four-assistant install test, 2026-10-12)
Porchsite works end to end for an assistant built like the one it was
developed with (own machine, open network, a local file passed into a tool
call). Consumer assistants broke on network blocks, the 1.6 MB upload, the
site's OAuth connector, and pictures held as files. In order:
- **RA-11** OPEN: One clean Claude run in the plain Claude chat app (no
  browser extension, only the two source files), to settle whether a
  non-technical owner gets through with Claude at all. Round 3's Claude run
  is invalid: it was given the wrong files.
- **RA-6** IN-PROGRESS (S1-1): site_check should report entries no visitor can reach
  from the home page (rendered by the site's own look), not just broken
  links and empty sections: a look that drops some entries left a thin
  home page and the check still passed.
- **RA-9** OPEN: The install guide's setup code as a hashed row in the
  site's database (as the installer does), not a Worker secret: no secret
  to delete after the claim, one step fewer, nothing for the audit check.
- **RA-10** OPEN: Uploading many photos costs one tool call each (34+ in a
  reunion build). A batch: several pictures per image_add call, or one
  upload link for many files.
- **RA-8** IN-PROGRESS: Each harness at its best. Done: the assistant
  guide (by app), and Grok Bot's Porchsite template, public and linked.
  Left: a Porchsite setup for each other app (a Claude Project or Skill, a
  custom GPT, Meta AI's skills), then a run with each.

## DEGRADING
- **SP-S1** IN-PROGRESS (S1-2): `site_state` returns 34-51 KB for an ordinary site,
  every item in full; heavy for an assistant's context. Consider a summary
  by default (ids, kinds, titles, states, versions) and the full data per
  item or on request. Found: an assistant running updates.

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
