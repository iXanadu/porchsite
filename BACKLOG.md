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

## DEGRADING
- **CF-F1** OPEN: An assistant that holds a picture as a file (one it made,
  or was sent by another agent) can't add it: content takes an https link
  or a photo_upload_link the owner has to open. Add a tool that takes the
  file itself (base64, size-capped, same checks as an upload), in both
  editions. Found: a first real install.

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
