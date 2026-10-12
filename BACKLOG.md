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

## READY FOR ASSISTANTS (a four-assistant install test, 2026-10-12)
Porchsite works end to end for an assistant built like the one it was
developed with (own machine, open network, a local file passed into a tool
call). Consumer assistants broke on network blocks, the 1.6 MB upload, the
site's OAuth connector, and pictures held as files. In order:
- **RA-4** IN-PROGRESS: One-page installer. Proven on a brand-new account
  (re-test run 1). Left: confirm the pre-filled token link opens filled in
  once signed in (run 1 opened it empty the first time; the page now says
  to open it again).
- **RA-5** IN-PROGRESS: The fair re-test (fresh account, one prompt,
  transcripts kept). Done: Claude, Dot, Muse. Left: GrokBot, then grading.
- **RA-6** OPEN: site_check should report entries no visitor can reach
  from the home page (rendered by the site's own look), not just broken
  links and empty sections: a look that drops some entries left a thin
  home page and the check still passed.
- **RA-7** OPEN: theme_needs reported 3 missing where 2 showed (event
  look, hero set). Find the third.

## DEGRADING
- **SP-S1** OPEN: `site_state` returns 34-51 KB for an ordinary site,
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
