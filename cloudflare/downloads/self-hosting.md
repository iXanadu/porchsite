# Self-hosting Porchsite (for the assistant coaching a developer)

Your person is a developer and wants to run Porchsite themselves. Tell them
the truth from this page; don't guess past it.

## The short answer

There are two editions of the same product: the same idea (an assistant
writes, the owner approves, every version kept), the same content model and
the same looks.

- **The Cloudflare edition is the one we ship.** It runs on your person's
  own Cloudflare account, on their database and their domain; nobody else
  hosts it. That's real self-hosting. Follow the
  [install guide](https://get.porchsite.dev/install.md), or they can run the
  same API calls themselves. It fits Cloudflare's free plan for a personal or
  small business site.
- **The server edition installs with Docker.** Python (FastAPI) and
  PostgreSQL on your person's own server, behind Caddy, which gets the HTTPS
  certificate by itself. It is the same product as the Cloudflare edition:
  passkey sign-in, the same safety rules and MCP tools, the same looks
  (pages render per request, byte for byte as the Cloudflare edition renders
  them), the theme catalog, analytics. One supported setup: Docker Compose
  with three containers (the app, PostgreSQL 17, Caddy). Its guide is
  `deploy/compose/README.md` in the repository.
- **The source** of both editions, the looks and the spec is at
  [https://github.com/iXanadu/porchsite](https://github.com/iXanadu/porchsite), under the MIT licence
  (the spec under CC BY 4.0). The Cloudflare bundle in
  [latest.json](https://get.porchsite.dev/latest.json) is built from it (one
  JavaScript module plus SQL files, checked by sha256).

## What a Cloudflare-edition site needs

So a developer can judge it:

- **Runtime:** a Cloudflare Workers-compatible runtime (the bundle is an ES
  module Worker, `compatibility_date` 2026-08-15, flags `nodejs_compat` and
  `global_fetch_strictly_public`).
- **Database:** Cloudflare D1 (SQLite). All content, every version of every
  item, the owner's passkeys and sessions, and **images** (stored in the
  database in chunks, up to 8 MB each) live here. The layout is in the
  `migrations/*.sql` files; apply new ones on update.
- **Key-value store:** Workers KV, for sign-in (OAuth) state.
- **Setup:** a one-time code stored only as a hash in `setup_codes`, with
  a 24-hour expiry; claiming deletes it. New installs create no setup secret.
  The owner never types it: whoever installs sends them
  `https://<site>/setup#code=<code>`, which fills it in without sending
  the code in the request URL. The hash is the sha256 of the code in
  unpadded base64url; the spec, §5, has the rules.
- **HTTPS and a stable address:** passkeys only work over HTTPS and only at
  the address where they were made.
- **Outbound requests:** the site fetches images from links an assistant
  gives it, and reads the theme catalog at get.porchsite.dev.

## Prepared public pages

Public HTML, Markdown and llms.txt may use bounded prepared copies after a
fresh live access check. Private content is never prebuilt. The Cloudflare
binding `SITE_URL` and server setting `PORCHSITE_SITE_URL` supply the stable
canonical origin; without a matching configured origin, rendering stays live.
Preserve that origin when updating because assistant tokens also bind to it.
The public cache policy remains no-cache/no-transform and conditional reads
still revalidate at the engine. Prepared data is disposable; published owner
content and approval remain the source of truth. Local timing is not evidence
of hosted CPU savings; release measurement reports identify the environment.

Prepared copies are off by default. An operator may opt in with
`PUBLIC_ARTIFACTS=1` on Workers or `PORCHSITE_PUBLIC_ARTIFACTS=1` on server,
plus the configured canonical site origin. Other flag values leave ordinary
live rendering in place. Invalidation still runs with delivery off. The
installer does not turn the flag on. Hosted CPU must be measured separately
before default enablement; local process CPU is diagnostic only.

## Running it on Cloudflare by hand

The [install guide](https://get.porchsite.dev/install.md) is written for an
assistant, but every step is one Cloudflare API call a developer can run with
`curl` and an API token (Workers Scripts, D1 and Workers KV edit; for a custom
domain also Zone, DNS and Workers Routes edit). Wrangler works too: a
`wrangler.jsonc` with the bundle as `main`, `no_bundle: true`, a D1 binding
`DB` and a KV binding `OAUTH_KV`. Issue the hashed setup row as described
in the install guide; do not add a setup-secret binding for a new site.

## What a server-edition site needs

- **A server with Docker** and the Compose plugin. A small VPS is enough.
- **A domain pointed at it:** DNS records for the domain and its `www.`
  name. The site lives at the bare domain; `www.` redirects there.
- **Ports 80 and 443** reachable from the internet, so Caddy can get and
  renew the certificate. Passkeys only work over HTTPS and only at the
  address where they were made.
- **Settings** in a `.env` file: the domain, the database password, the
  release.
- **Storage:** everything (content, every version, images, passkeys,
  connected assistants) is in PostgreSQL, in one Docker volume. A backup is
  a `pg_dump` of that database.
- **Outbound requests**, as for the Cloudflare edition.

Once it's up, whoever installed it runs the `setup-link` admin command and
sends the owner the link it prints (`https://<domain>/setup#code=…`, good
for 24 hours; a new one replaces it). The owner opens it and saves a
passkey: owners never need a terminal, a settings file or a code to type.
The assistant connects at `https://<domain>/mcp`. A `check` admin command
reports whether the database, schema, looks and settings are sound.

## Moving to your own server

Bottom line: pages, entries, settings and photos move. Private mode needs a separate owner-approved change; import files cannot change it. Edit history, past approvals, passkeys, readers and assistant keys don't, so you set them up again. Allow about half a day for a person who already runs a server, or 1-2 hours for an assistant with access to the server, plus up to an hour for the address change to spread.

1. Install the server edition on your server: the app, PostgreSQL and Caddy, with Docker Compose. The guide is `deploy/compose/README.md`.
2. Claim the new site with its setup code on a temporary address, and create your passkey. The live site keeps running.
3. Bring the content across with the import page, `/review/import`. Each file holds up to 25 MiB and 200 items (each photo up to 8 MiB), so a photo-heavy site needs several. Each file creates its own approval request; the owner approves each one.
4. Compare the two sites page by page.
5. Remove the domain's Worker custom-domain mapping or route, then in Cloudflare's DNS point your domain at the server instead of the Worker.
6. Create a passkey at the final domain using the server's `recovery-link` admin command: the temporary-address passkey does not work there. Reconnect your assistant with new credentials. The connection address stays the same if you keep the same domain.

To undo it, point DNS back. Keep the Cloudflare site for a few days before deleting it.

## Getting a small server

**One box, about $5 a month.**

- **What it buys:** any provider with a small Linux server works. About $5 or €5 a month buys 1-4 GB of memory, a shared processor and 20-50 GB of disk.
- **Where to look:** Akamai (Linode), DigitalOcean, Vultr, Hetzner, OVHcloud, Scaleway, netcup, IONOS, UpCloud, or a good local host. Prices move constantly, so treat these as places to look, not quotes.
- **Size:** 2 GB of memory is a comfortable start, since Porchsite runs the app and PostgreSQL. An EU-resident host makes GDPR simpler.

**About ten minutes by hand:**

1. Create an Ubuntu LTS server with your SSH key.
2. Point a DNS name at it.
3. Update the system and make yourself a user with sudo.
4. Start your coding assistant there.

**Then prompt it, one step at a time, and ask for proof after each:**

1. "Look before touching: list what's installed and listening, worst first."
2. "Standard hardening: automatic security updates, a firewall allowing only SSH, HTTP and HTTPS, key-only SSH, fail2ban. Explain each change first, and show me the command that proves it."
3. "Install Porchsite's server edition from https://github.com/iXanadu/porchsite following deploy/compose/README.md. Caddy gets the certificate itself; prove /health is ok over https."
4. "Set up a nightly off-box backup of the PostgreSQL database, and show me a restore works."

**Worth knowing:**

- $5 is the box, not the backups.
- Give the assistant a user account with sudo, not root.
- A cheap server is shared: fine for a site, not for anything that's time-critical.

## A reverse proxy must preserve access checks

The supplied Caddy setup has no response cache. Keep shared caching off for
the entire site if you add a proxy or CDN. Before enabling private mode,
disable it and purge previously public pages, feeds, search indexes,
sitemaps, media and redirects at every cache you operate. Otherwise a proxy
can answer from its old public copy without asking Porchsite.

Bypass cache reads **and writes** for both `__Host-sk_owner` and
`__Host-sk_reader`; forward those cookies unchanged. `Vary: Cookie` alone
does not provide isolation. Preserve private/no-store/no-transform and
security headers. Never serve stale content, including when the origin
returns 404, times out or is refreshing a response in the background.

Do not cache `/media/` longer than pages. Public photos send
`no-cache, no-transform` with an ETag: every reuse revalidates, unchanged
published photos can return 304, and removed photos return 404 before any
validator check. Signed-in media is private/no-store with no validators.
Earlier releases used a one-year immutable header. Keep the conservative
proxy override `private, no-store, no-transform` during upgrades and
rollbacks, and remove it only after verifying the new origin policy and
every intermediary's revalidation and stale-off behavior. Keep cookie
bypass, 404 passthrough and purge requirements in place. Purge operated
caches after unpublishing photos or changing privacy. This cannot revoke
downloaded files or a browser's still-fresh old one-year copy. The deploy
guide includes an [example Nginx configuration and local verification steps](https://github.com/iXanadu/porchsite/blob/main/deploy/compose/README.md#reverse-proxies-and-caches).

## Update policy

No site updates itself; the owner decides. The site checks latest.json once
a day and only tells: `site_state.update` for the assistant, a line on the
owner's review page. Every release stays downloadable, schema changes only
ever add, and each release is tested with the previous one running on its
schema, so a rollback is putting the previous release back with no database
step. A release with `security: true` fixes something an attacker could use:
say so, and suggest updating soon.

## Updating the Cloudflare edition

On the owner's yes: apply every file in latest.json's `all_migrations` that
the site's `_sitekeeper_migrations` table doesn't list, in order (not just
`migrations`, which names one release's new files), upload the new bundle
with the same bindings, delete the `SETUP_CODE` secret if it is still
there, and check the `X-Porchsite-Release` header (retry for up to 30
seconds). Before rolling back, run `python3 scripts/check-private-downgrade --site https://example.com --target RELEASE`; a warning stops the procedure unless the owner explicitly confirms the exposure. Roll back by
re-uploading the previous bundle from `v/<release>/` (hashes in
`v/<release>/files.json`), with no schema step. Step by step: "Updating" in
the install guide.

## Updating the server edition

A release id is `<date>-<commit>` and names a commit; latest.json gives the
full `commit`, and each release is tagged `release/<release id>`. Releases
made before the repository went public (up to 2026.10.12) were built from
an earlier private history: their files and hashes stay on
get.porchsite.dev, but their commits and tags aren't in the public
repository. On the
owner's yes, in `deploy/compose/`: note the running release (the
`X-Porchsite-Release` header), dump the database, `git fetch --tags` and
`git checkout release/<release id>` (or `git checkout <commit>` if the tag
isn't there), set `PORCHSITE_RELEASE=<release id>` in `.env`, run
`docker compose up -d --build`, then the `check` admin command; the header
names the new release. The schema migrates itself at start, and only ever
adds. Roll back: check out the previous release's tag (or commit), set
`PORCHSITE_RELEASE` back, `docker compose up -d --build`; no schema step.
Reconnect the assistant if `reconnect` was true. The full procedure is
"Update" in `deploy/compose/README.md`.

To check older published photos for saved location data, run `python3 scripts/photo-location-check --site https://example.com` (add `--json` for a report of photo URLs and the pages that use them). For each flagged photo, download it and add it again with `image_add`, which strips location on add; draft replacements of its `/media/` address in every entry or other item that uses it, then send one `approval_request` listing all changed items. The old file stays in the site's history: the owner can still see it, and approving a rollback to an older item version would publish it again. Once no published item uses the old photo, the app stops serving it publicly. Anyone or any search engine that already fetched it keeps their copy; photos were served with a one-year cache lifetime. The checker only reads public pages and photos; on a private site there is nothing public to check. It has page, file, response-size and timeout limits; exit codes are 0 for clean or private, 2 for location found, and 1 for any error or incomplete scan. An error outranks a find. Nonstandard location data in JPEG APP2 is outside the checker and current stripper's coverage.

## Limits to say out loud

- Looks and fixes are welcome as pull requests on GitHub; a running site
  can also share a look with `theme_submit`, and anyone can ask for a
  feature or a fix at https://porchsite.dev/ask.
- The server edition has one supported setup (Docker Compose on one
  machine). Other ways of running it (a bare Python install, another web
  server, a managed database) can work, but aren't documented or supported.
- One owner per site; approvals need that owner's passkey.

### AI training and public re-checks

AI training is allowed by default. To block the named training crawlers,
propose `ai_training_disabled: true` on the site item and let the owner
approve it. Search crawlers and agents fetching for a person stay allowed.
The site declares the choice in robots.txt and its response headers; this
is a preference, not a guarantee that every crawler obeys it. Private sites
keep their existing disallow-all response and blank public pages.

Public pages, feeds and sitemap support ETag re-checks: an unchanged
representation returns 304 with no body. Owner and reader sessions keep
private, no-store responses. Self-hosted proxies must respect these cache
headers and bypass authenticated responses; disable host robots injection
or content conversion that overrides the site's declaration.

Public HTML pages advertise a Markdown copy at their address plus `index.md`
(for example, `/notes/example/index.md`). An explicit `Accept: text/markdown`
also selects that copy at the HTML address; proxies must honor `Vary: Accept`.
`/llms.txt` provides a bounded map of the home page and published local entries.
Public HTML also carries inert schema.org page data from the visible
approved title and description, under the existing script policy.
Copies use the text the look displays; private sites expose none of these
new paths, including to signed-in owners and readers.

### Alerts on your devices

In the Home Screen app, tap Review (bottom right) to manage alerts.

To check it on a device:
1. Open the site from its Home Screen icon and sign in as the owner.
2. From a site page, tap Review at the bottom right and check that alerts
   can be managed there.
3. Sign out and check that the Review link disappears from site pages.

Alerts need HTTPS and outbound access to the allowed push services.

On `/review`, the owner can turn alerts on or off for each device and use
`/review/alerts` to remove saved devices. Alerts are off until the owner
turns them on and grants the browser permission.
Alerts are a nudge, not a guarantee. Phones and browsers can delay or drop them. Your assistant still sends you the link.
A notification contains only the site name,
"Your site has a change waiting for you" and a link to `/review`; the site
name may appear on the lock screen. The notification opens /review; sign in
with your passkey if asked. A notification never approves a change. The assistant and
readers cannot choose targets or turn alerts on. On iPhone this requires
iOS 16.4 or later: Share → Add to Home Screen → open from the icon → turn
alerts on. Remove a device on `/review/alerts`. Recovery removes all alert
subscriptions and turns alerts off on every device. A notification already
sent cannot be
recalled. Nothing changes about the owner's approval rule.

## Private sites, recovery and rollback

A look does not make a site private. Propose `site.private: true` separately;
only the owner can approve it. A private site's visitors get a blank page,
including feeds, search, sitemap and media. Invite readers through
`/review/readers`; each saves their own passkey. Reader access is published
pages only. Revoking ends authorizations made after it commits, including
old sessions; already delivered or authorized in-flight copies remain.
Search-engine copies and pictures fetched before private mode also remain.

If Cloudflare Web Analytics automatic setup is on for the zone in the hosting account, exclude the private site's hostname.

Private mode hides site content, not sign-in and connection routes. `/login`,
`/authorize`, `/oauth/token`, `/oauth/register` and OAuth `/.well-known/`
metadata stay reachable so the owner can sign in and assistants can connect. `/.well-known/porchsite-release` reports only the
release and private-mode minimum, without site content. `/mcp` still needs
an assistant token. Setup, recovery and invitation/upload/passkey links
keep their own checks so their links work; setup redirects after the site is
claimed. None of these routes shows the site's pages.

The minimum private-capable release is reported by `site_state.update.rollback`
and `/.well-known/porchsite-release` as `private_floor`. Before **any rollback
upload or checkout**, run from the repository:

```sh
python3 scripts/check-private-downgrade --site https://example.com --target RELEASE
```

An older target, or missing/unknown state or minimum for any target, stops
and explains that the site becomes public because old code ignores private
mode. Choose the reported minimum or newer, or deliberately turn private off
first. Only after the owner explicitly says yes to this exposure may the
assistant add `--confirm`; never infer permission. The warning still prints.
Same-day release ids cannot order commits, so the check warns conservatively
for a different same-day commit. This check performs no upload or checkout.

**This is a warning procedure, not prevention.** The dashboard rollback
button, direct upload with the hosting API key, raw checkout, an older
database restore, or a hostile assistant holding the key can expose a private
site. The key holder can skip the check or misuse its confirmation flag.
No additive schema change can make old code enforce private mode.

If the owner loses every passkey, use the hosting account to issue a recovery
link, good once for 24 hours. This is never an MCP tool. Completing `/recover`
in one transaction replaces every owner passkey, cancels unused add-passkey
links and unused reader invitations, and ends all owner and reader sessions. Reader passkeys are kept and
can sign in again. Setup stays closed after claim. Send recovery links only
through a private channel and do not record them in chat logs or source.

Cloudflare hosting operator (D1 query permission; environment holds the
account id and API token):

```sh
node cloudflare/scripts/recovery-link.mjs --database DATABASE_ID --origin https://example.com
```

Server hosting operator, with the site's existing `PORCHSITE_DSN` set:

```sh
python -m server.app.cli recovery-link --origin https://example.com
```

The printed link uses `/recover#code=...`; the code stays out of the
initial request URL. Give this one-use link privately to the owner. The
page clears the address bar before the passkey step. Old query-form links
work for this release only; the following product release refuses them.
The code is random and stored only as a hash with an expiry. A new link
invalidates the previous link. Hosting-account access already grants control
of the site; recovery does not protect against a compromised hosting account.

### Rolling back stream settings

A release from before expanded streams reads at most the first eight
streams and twelve home sections. It has no all-stream archive or title
sorting. Entries in later streams use its first-stream fallback, which may
change their grouping and addresses until newer code returns. The full
settings and their history stay in the database. An edit made with older
code creates a version with only the settings that code understands;
newer code does not silently restore omitted settings into that version.
This does not change the private-site minimum release or its rollback
warning.

Setup links are credentials. New links use `/setup#code=...`, so the code
is not sent in the HTTP request URL; it is submitted only in the setup
POST body. The supported server image disables Uvicorn access logging and
the supplied Caddy configuration keeps access logging off. If you enable
reverse-proxy access logs or other host tracing, omit or redact query
strings before issuing a setup link: old query links are accepted only in
the introducing release, and recovery links still use query strings.
Application code cannot erase logs retained by your hosting operator.
