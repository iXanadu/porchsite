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
- **S3-7** IN-PROGRESS (BLOCKING, privacy): stored pictures keep their
  location metadata. `image_add`, the upload link and hotlinks store the
  bytes as given, so a phone photo can put the place it was taken (often
  a home) on a published page; true on the live release too. Remove
  location (GPS) metadata from every picture as it is stored, keeping the
  orientation so photos don't turn sideways; both editions, spec first.
  Pictures already stored are not changed by this; the owner decides
  about those. Found: stage 3 security review.
- **S3-6** IN-PROGRESS (decided 2026-10-15, replaces S3-5): pictures
  are compressed before upload by default; originals stay possible, and
  the assistant says plainly before using them that bigger files use more
  of the free plan's limits, make pages slower and take more storage.
  Same words in the `image_add` and `photo_upload_link` descriptions and
  in `image_add`'s reply when a big picture arrives; the phone upload
  page shrinks pictures in the browser to web size (about 2400 px on the
  long side) unless the person ticks "keep the original". Limits stay 8
  MB. Both editions, spec first; the guide's photo advice too, worded so
  it is true for the live release as well (main's INSTALL.md is read live).




## STAGE 4 (2026-10-15, after S3-6/S3-7): what a real listing site needs
Found building a single-property listing site on the live release.
- **S4-1** OPEN (owner requirement): owner-approved embeds. Public pages
  send `default-src 'none'`, so a video or a 3D tour can only be a link.
  Each site keeps a list of allowed embed sources that changes only
  through the owner's approval; an assistant proposes an embed (its URL),
  the review page shows the source plainly, and the tools tell the owner
  in plain words what an embed is and that they are approving a new
  source. Nothing open by default, nothing the owner can't approve.
  YouTube and Matterport first. Security threat model before code; spec
  first; both editions.
- **S4-2** OPEN: Many photos from the owner's phone at once. An assistant
  without a code runner can't send 40 photos (base64 in a tool call is
  about 16 MB of text). A signed-in owner page that takes many photos,
  shrinks each in the browser (S3-6 rules), strips location (S3-7) and
  tells the assistant the stored paths. Security review first.
- **S4-3** OPEN: A look for a property listing. No catalog look fits;
  product-page wants a square engraving-style hero and its art guidance
  ("engraving, pick an animal") misleads for a photo listing. A Listing
  look with a wide photographic hero, a photo gallery, stats, map and
  visit/contact; per-look art guidance in theme_needs.
- **S4-4** OPEN: Owner told promptly and privately when an approval is
  waiting, not only through a link the assistant passes on. Design first
  (browser push to the owner's signed-in device, or email), owner picks.
- **S4-5** OPEN: Analytics writes one database row per page view and per
  heartbeat; the free plan allows 100,000 row writes a day across the
  account, so a busy open-house weekend could use it up. Batch or sample.
- **S4-6** OPEN: item_create with many pictures in its body is slow (an
  entry with 40 pictures: about 128 ms CPU, 5 s); look up the pictures in
  one query.
- **S4-7** OPEN: The assistant can't see what it built before the owner
  approves: no preview it can open. Design with security (a short-lived
  read-only preview for the assistant).
- **S4-8** OPEN: theme_list shows every catalog look as installed, so the
  guide's "theme_list then theme_install" confuses a first-time assistant.
  Say plainly which looks need installing (none, today).

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
