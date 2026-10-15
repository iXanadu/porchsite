# Local request CPU profiles

Run from a checkout with `cloudflare/node_modules` installed. Node 25 or later
is required for the local SQLite fixture writer. The script launches only
local Wrangler, uses a disposable D1/KV state directory, and never deploys.

```sh
node cloudflare/scripts/cpu-profile.mjs --output /tmp/site-cpu-current

# Compare another checkout using exactly the same harness and fixtures.
node cloudflare/scripts/cpu-profile.mjs \
  --build /path/to/release-checkout \
  --looks menu-page --cases approval_status,site_check,public:home \
  --repeats 3 --output /tmp/site-cpu-release
```

Both checkouts need their locked npm dependencies. Outputs belong outside
the repository. Choose a fresh directory for each run. The script acquires
the shared local suite lock, refuses a one-minute load of 8 or more, and
releases its lock on exit. It refuses an occupied lock. A coordinator that
already owns that lock can pass `--lock-held true` and must release it.
The lock is `/tmp/porchsite-suite.lock` on every platform. Local
HTTP/inspector ports default to 8801/9241; change them with `--port`
and `--inspector`. Do not run another measurement concurrently.

By default every sample is measured three times in each mode:

- **Cold** is the first HTTP request in a newly launched Worker. The
  profiler attaches after Wrangler's inspector is ready; eager global
  initialization before attachment is excluded. This is the headline
  request number; it does not measure the separate startup limit.
- **Warm** starts a fresh Worker for the case, performs one unmeasured
  request of the same case, and then measures each repeat separately.
  Storage is reset before every request, including write tools, so a
  second write exercises the same successful operation and version.

`--looks` and `--cases` accept comma-separated names. Case names are printed
in `results.json`; a tool name selects all its variants. `--modes cold` or
`--modes warm` selects one mode. `--repeats 1` is useful for a fixture smoke
run, but gives no range of observed variability.

To yield the shared lock, send the harness process `SIGUSR2`. It finishes
the current observation, writes an explicitly incomplete table and exits
75 after shutting down Wrangler. Resume with the same arguments and
`--resume true`; completed observations are preserved. Resuming refuses a
different revision, product diff, release label or minification setting.

The measured path is the build's actual `index.ts` HTTP handler, including
owner-session authentication for review pages and assistant-key lookup plus
MCP transport for tools. Every tool discovered by `tools/list` must have a
successful measured case in a full run; an HTTP error, MCP error, or missing
tool fails the run. This does not measure OAuth-token authentication.

Wrangler's dry-run build preserves a minified install-style bundle and its
source map; local dev executes that exact artifact with bundling disabled.
No upload occurs. `--minify false` permits a separate source-style comparison.
The default `__RELEASE__` is the checked-out commit's UTC date and short hash;
override it with `--release`. The ordinary update cache is seeded locally so
every sample exercises its cached KV path consistently. Uncached update
requests and OAuth authentication need separate hosted observations.

Public coverage includes home, entry, archive, tag, missing-page, feed,
search index, stylesheet, beacon script and robots responses. Review
coverage includes the inbox, approval detail, home/entry/archive/tag
previews, writing index/new/editor/preview, import, share-card listing,
passkeys, assistants, stats, publish history and revert page. These are GET
page measurements; form submissions and passkey ceremonies are not covered.
Tools include summary/full/selected `site_state`, and image upload with a
small PNG, the legacy 8 MiB limit, and eight distinct 1 MiB PNGs when the
build supports batches. Padded PNG fixtures exercise decoded-byte and D1
storage costs, not pixel decoding.

Fixtures use the selected build's validator on its sample data. Published
items retain their sample content. One staged tagline edit and its approval,
one publish-history record, an owner session, an assistant key, a waiting
photo link and a private look support successful owner/tool requests. The
same fixture is restored through the local SQLite database between requests.
The generated wrapper intercepts all non-local outbound fetches: the catalog,
theme package, update check and community queue receive deterministic local
responses. No request or submission reaches a real service. Upstream
network/authentication costs and failures are outside this measurement.

Each run writes:

- `table.md`: one row per sample/request, cold first and warm beside it;
  numbers are min/median/max of active sampled milliseconds.
- `results.json`: per-request HTTP status, response length, tool success,
  wall time, active/idle sample totals and function totals.
- Native `*.cpuprofile` files for independent inspection, and `method.json`
  with the build revision, product diff hash, dirty flag and settings.
- A `runtime-*` directory with the generated local wrapper, config and
  disposable storage. It contains only local fixture data and can be
  deleted with the rest of the output once review is complete.
  Its `bundle/` directory retains the executed Worker, source map and
  esbuild metadata for package attribution after Wrangler shuts down.

CPU samples use a requested 100 microsecond interval. Active time is the sum
of `timeDeltas` except `(idle)`; `(program)` and garbage collection count.
Wall time is recorded separately. A zero active-sample result means the
sampler observed no active stack, **not** that the request consumed zero CPU.
Very short requests need more observations. Sampling, native work attribution,
local hardware, runtime versions and inspector overhead affect these numbers.
The script does not turn a local measurement into a hosted `cpuTimeMs` value.
Hosted remeasurement is required to accept a Free-plan CPU budget.
