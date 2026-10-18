# Porchsite

A website your AI assistant builds and keeps up to date. Nothing goes live
until you approve it.

- **Cloudflare edition** (`cloudflare/`): runs free on your own Cloudflare
  account. Tell your assistant: "Set up Porchsite from porchsite.dev."
- **Server edition** (`server/`): Python and PostgreSQL on your own server.
- **Looks** (`themes/`): shared by both editions.
- **Spec** (`spec/`): what every edition must do, and the check that proves it.

Licence: MIT for code, CC BY 4.0 for the spec.

Optional public response reuse stays off by default. It can reduce the cost
of repeat requests in the same location, but filling a missing copy costs
more CPU than serving without this cache. In local tests on one 200-entry
site, a hit saved about 7.4 ms and a miss added 8.3 ms: roughly 53% of cold
requests would need to hit for a net CPU saving. With prepared public copies
enabled, the corresponding figures were 1.0 ms saved and 5.3 ms added,
requiring about 84% hits. A miss without prepared copies took about 29 ms
versus 20 ms without response reuse, above the 10 ms CPU budget.

These are local measurements, not hosted or tail-latency results, and are
not an enablement recommendation. A hosted decision needs the owner's
approval and measurements for that site's hit rate and hit/miss costs.
These measurements predate the prepared-copy proof optimization; repeat the
comparison for the deployment being considered.
See [the response reuse contract](spec/SPEC.md#perf-4-optional-public-response-reuse).

Visitor statistics record at most 200 page views per visitor per day. The
visitor key is the existing daily salted address/user-agent hash; raw
addresses and user agents are not stored. Rotating IP addresses or user
agents produces new keys. Database reads and heartbeat writes remain
uncapped; this is not a site-wide quota or complete denial-of-service
protection. Views above the cap are omitted, including real visitors'
views. Retention cleanup runs at most once per increasing site-local date
when a valid page-view event arrives.
