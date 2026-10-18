# Release D1 row check

The release check measures the real Worker entry on local D1 for all twelve
sample sites and a synthetic 200-entry services site. For each, prepared
copies off/on are separate fresh instances. Requests are the first GET
(MISS plus admission when enabled), the next unconditional GET (certified
prepared HIT when enabled), then a conditional 304. Response reuse stays
off. Every D1 read and write is counted, including request waitUntil work.
This measures database rows, not CPU or hosted billing.

The expanded format keeps all 78 page cells and adds fourteen write cells:
first-day and repeat beacon views, the 201st attempt on an existing daily
visitor, a progress heartbeat, approvals of one and 200 new entries, and
one three-item JSON import file, each with copies off/on. Import remains
pending content. Each operation starts on its own synthetic disposable site.
Owner/session seeding and the normal form GET are named setup costs outside
the POST scope; the real POST's authentication, checks and background D1
work count. Invalid-session and CSRF controls must leave content unchanged.
No real credentials or remote services are used.

For the introducing format change use `--record --rebase`: preserve the
published 78-cell predecessor record and measure its exact archived bundle
on all 92 matching cells. Both artifacts are measured, not populated from
copied numbers. The original product bundle remains unchanged; only a
separately named local measurement copy routes native module imports through
a live-export waitUntil adapter. Original, derived and adapter hashes plus
import mapping are recorded separately. Native and context tasks share one
request-local settlement scope. No idle-counter or sleep completion proof.
This adapter never ships as a product handler.

Before committing a release candidate, from the repository root:

```sh
node scripts/d1-rows-check.mjs --record
git diff -- spec/fixtures/d1-rows.json
```

Review and commit the record. The check is read-only by default:

```sh
node scripts/d1-rows-check.mjs --release YYYY.MM.DD-abcdef0
```

The release id must be the newest changelog entry. Without `--release`,
the newest published entry is used as the predecessor for preparation.
The script owns the suite lock unless its coordinator passes `--lock-held`.
Every invocation has a 120-second budget, including build and cleanup.
Dependencies must already be installed. `--output <directory>` retains
local numeric diagnostics. `--archives <directory>` and `--manifests
<directory>` can read restored archives from outside an isolated checkout;
the predecessor release and artifact hash must still match its manifest.

Any read or write increase in any cell requires the current release's
`rows_justification`, a nonempty plain line up to 1000 characters. This
allows a build for review; the owner must approve the increase before it
is deployed. It cannot excuse missing measurements or a failed check.
The log prints every old/new value and read/write daily-limit arithmetic.
The published changelog keeps the reason.

The previous committed record is loaded from the previous release's git
revision. Only a genuinely absent original record bootstraps from the exact archived predecessor,
never from copied current values. If the corpus, measurement method or
toolchain changes, `--record --rebase` remeasures that archived predecessor
on the new inputs and retains its original record alongside the labelled
comparison. Review the rebase; it must not hide a regression.

The fixed application fixture clock is 2030-01-01T12:00:00Z, within the
bundled finite timezone rules. SQLite's host
clock remains real and its SQL is unchanged; the future application clock
keeps valid fixture admissions ahead of that host clock. This is a stable
row-count scenario, not today's event selection or an expiry-race test.
The gate refuses once the fixture clock is no longer in the future. Native
first/raw/batch adapter tests and the product's clock/race tests remain
required. The observer never records SQL binds or content.

Free-plan examples use the documented daily account allowances checked
2026-10-18: 5 million rows read and 100,000 rows written. The smaller of the
two request equivalents is only an illustrative D1 bound assuming no other
activity. Other sites, writes, Workers limits and storage reduce usable
traffic. A 304 is a request equivalent, not an analytics page view.

Source: https://developers.cloudflare.com/d1/platform/pricing/
