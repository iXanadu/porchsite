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
1. PERF-2 (lazy entry Markdown) and PERF-3 (image sizing off GET): the
   remaining CPU on a first page render.
2. AG-6: owner review pages give a signed-in agent the same light
   versions, protected like any other private data (the last part of
   agent access to private sites; keys, read tools and private pages
   over HTTP shipped).
