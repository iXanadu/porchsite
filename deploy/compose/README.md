# Porchsite, server edition, with Docker Compose

The supported way to run the server edition on your own server: three
containers on one machine.

- **app**: Porchsite (Python, `server/Dockerfile`), built from this repository.
- **db**: PostgreSQL 17. Everything lives here: content, every version,
  images, your passkeys, connected assistants. Its data is the `db` volume.
- **caddy**: the web server in front. It gets and renews the HTTPS
  certificate for your domain by itself and passes requests to the app.

## What you need

- A server with Docker and the Compose plugin (`docker compose version`).
  A small VPS is enough.
- A domain, with DNS records for `example.com` and `www.example.com`
  (A, or AAAA for IPv6) pointing at the server.
- Ports 80 and 443 open to the internet. Caddy needs both to get the
  certificate; passkeys work only over HTTPS.
- A copy of this repository on the server.

## Start

```bash
cd deploy/compose
cp .env.example .env
```

Edit `.env`:

- `PORCHSITE_DOMAIN`: your domain, bare (`example.com`, no `www.`, no
  `https://`).
- `PORCHSITE_DB_PASSWORD`: letters and digits only, e.g.
  `openssl rand -hex 24`. Set it before the first start; the database keeps
  the first password it sees.
- `PORCHSITE_RELEASE`: the release you're running (shown in the
  `X-Porchsite-Release` header of every answer).

Then:

```bash
docker compose up -d --build
docker compose exec app python -m server.app.cli check
```

The database schema applies itself when the app starts. `check` says whether
the database answers, the schema is current, the looks are found and the
settings make sense; it exits 1 if anything is wrong. Logs:
`docker compose logs -f app` (or `caddy` while the certificate is being
fetched).

## Claim the site

The owner never needs a terminal. Whoever installs the site makes a setup
link and sends it to them:

```bash
docker compose exec app python -m server.app.cli setup-link
```

It prints one line, `https://example.com/setup?code=…` (the address comes
from `PORCHSITE_SITE_URL`, which defaults to `https://<PORCHSITE_DOMAIN>`).
Send it to the owner however you like. They open it, add their name, and
tap **Create my passkey** (Face ID, fingerprint or device PIN); the code is
already filled in. From then on they sign in at `/login`, approve changes at
`/review`, and add a passkey for another device at `/review/passkeys`.

- The link works once and for 24 hours (`--hours N` for another span, up to
  720). Running `setup-link` again makes a new link and the old one stops
  working: no settings change or restart needed.
- Only the code's hash is stored. The page tells the browser not to pass
  the address on or cache it, and once the site is claimed every setup code
  is dead: the link then leads to sign-in, and `setup-link` refuses
  ("already claimed; use a passkey link from the owner's page to add a
  device").
- The older way still works: a code in `PORCHSITE_SETUP_CODE` in `.env`
  (send `https://example.com/setup?code=<that code>`). Empty it once the
  site is claimed and run `docker compose up -d`; `check` warns while it's
  still set.

## Connect your assistant

Give your assistant the site's MCP address:

```
https://example.com/mcp
```

It signs in over OAuth; you approve it once with your passkey. Connected
assistants are listed at `/review/assistants`, where you can disconnect
them. Nothing an assistant writes goes live until you approve it at
`/review`.

For a script or a test, an admin can mint a token without the browser step
(it shows on `/review/assistants` like any assistant):

```bash
docker compose exec app python -m server.app.cli token --name <assistant>
```

## Update

Porchsite never updates itself; the owner decides, and whoever looks after
the server (often their assistant, coaching) does it on their yes.

**Knowing there is one.** The site checks
`https://get.porchsite.dev/latest.json` once a day (it only reads; it
never downloads code). The assistant's `site_state` returns `update`
(`available`, `latest`, `security`, `changes`, `migrations`, `reconnect`),
and the owner's `/review` page shows a line, marked "Security update" for a
security release. Read `latest.json` directly for the same facts plus
`commit`; the history is at `https://get.porchsite.dev/changelog/`. This
needs `PORCHSITE_RELEASE` set to the release you run: a site on `dev`
never checks.

**Releases are commits.** A release id is `<date>-<commit>`, e.g.
`2026.10.11-13513a3` is commit `13513a3`; `latest.json` gives the full
`commit`. Each release is also tagged `release/<release id>`, e.g.
`release/2026.10.11-13513a3`. Both editions share the ids.

### Update (on the owner's yes)

```bash
cd deploy/compose
curl -sI https://example.com/ | grep -i x-porchsite-release   # RUNNING: write it down
docker compose exec -T db pg_dump -U porchsite --clean --if-exists porchsite | gzip > porchsite-$(date +%F).sql.gz
git fetch --tags origin
git checkout release/<release id>       # or, if the tag isn't there: git checkout <commit> (latest.json)
git rev-parse --short HEAD               # the part after the dash in the release id
# in .env: PORCHSITE_RELEASE=<release id>
docker compose up -d --build
docker compose exec app python -m server.app.cli check
curl -sI https://example.com/ | grep -i x-porchsite-release   # the new id
```

The schema migrates itself when the new app starts. Migrations only ever
add (tables, nullable or defaulted columns), so content is untouched and
the release before keeps working on the new schema. `check` must pass, the
header must name the new release, and `site_state` returns it as `release`.
If `reconnect` was true, the owner removes the site's connector in their
assistant app and adds it again, so the assistant sees the new tools.

### Roll back

```bash
git checkout release/<RUNNING>          # or: git checkout <RUNNING's commit> (the part after the dash)
# in .env: PORCHSITE_RELEASE=<RUNNING>
docker compose up -d --build
docker compose exec app python -m server.app.cli check
```

No schema step: the newer tables and columns stay and the older app ignores
them (every release is tested against the next one's schema before it is
published). Don't restore the dump unless data itself is damaged:
restoring loses everything written since.

## Reverse proxies and caches

The supplied Caddy configuration passes requests through without a response
cache. Keep that behavior if another proxy or CDN sits in front of it.
Before turning private mode on, disable shared caching for the site's whole
hostname and purge existing copies, including `/media/`, feeds, search and
sitemaps. A cached public response can otherwise answer without reaching
the app's private-site check.

Requests carrying either `__Host-sk_owner` or `__Host-sk_reader` must bypass
both cache reads and cache writes. Forward both cookies unchanged. Do not
use `Vary: Cookie` alone or cache signed-in pages by a shared URL. Preserve
the app's `private, no-store, no-transform`, `Set-Cookie`, status and security
headers. Do not replace an origin 404 with a cached success, even during an
upstream failure or a background refresh; disable serve-stale entirely.

Public photos now send `no-cache, no-transform` with an ETag. Every reuse
must revalidate against the origin; an unchanged published image can answer
304 without downloading its bytes again. Removing its last published
reference returns 404 before checking that tag. Signed-in media is
`private, no-store, no-transform` and has no validator.

Earlier releases send `public, max-age=31536000, immutable`. During an
upgrade or rollback, keep the example's conservative media override
`private, no-store, no-transform` at the outermost proxy. Remove it only
when the new origin policy is running and every intermediary honors
revalidation and cannot serve stale responses. A proxy must never keep
`/media/` longer than pages. Purge all caches you operate after removing a
published picture, replacing location-bearing photos, or changing privacy.
Revoke cached redirects too. Neither this update nor an origin 404 erases
a browser's already-fresh old one-year copy or earlier downloads.

For an existing Nginx TLS server, this example disables shared response
caching, bypasses both session cookies explicitly, and prevents new media
copies being stored. The `map` belongs in the enclosing `http` block; the
other directives belong in this site's existing `server` block. Replace
the example upstream with the app's **private** address. If using a host
port, bind it to loopback only; the Compose setup publishes no app port.
Do not expose the app directly: it trusts its proxy's forwarding headers.
Nginx does not inherit a parent's `add_header` directives when a location
sets any of its own. Repeat every server-level `add_header` inside the
media location too; the example repeats HSTS. Repeat any other headers in
your existing server configuration, preserving their values and `always`.

```nginx
# http context
map $http_cookie $porchsite_session {
    default 0;
    "~(?:^|;[[:space:]]*)(?:__Host-sk_owner|__Host-sk_reader)=" 1;
}

# Inside the site's existing HTTPS server (certificates omitted).
proxy_cache off;
proxy_cache_bypass $porchsite_session $http_authorization;
proxy_no_cache $porchsite_session $http_authorization;
proxy_cache_use_stale off;
proxy_cache_background_update off;
proxy_intercept_errors off;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;
add_header Strict-Transport-Security "max-age=31536000" always;

location / {
    proxy_pass http://127.0.0.1:8000;
}
location /media/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_hide_header Cache-Control;
    proxy_hide_header Expires;
    add_header Cache-Control "private, no-store, no-transform" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
}
```

Audit all matching locations and every proxy/CDN layer: a separate image
location or a provider's "cache everything" rule can override this example.
Do not configure `proxy_ignore_headers` to ignore Cache-Control, Set-Cookie
or Vary. Reload only after `nginx -t` succeeds. The directive semantics are
documented in the [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).
After updating the origin media policy, remove the interim media header
override only after verifying every intervening cache honors revalidation
and cannot serve stale responses. Cookie bypass, 404 passthrough and purge
requirements still apply; an origin header cannot fix a misconfigured cache.

Verify with disposable local content before using private mode: fetch a
published photo through the proxy, unpublish its last reference, then fetch
that same URL again. An anonymous request must get the origin's 404, with
no old image body. After turning private on, all formerly public content
URLs must return the blank private 404 even with conditional headers.
Signed-in owner and reader requests must each reach the app; a following
anonymous request must never reuse their response. Check both GET and HEAD,
and check the proxy/CDN's cache logs; an `Age` header alone is not proof.

## Back up

Everything is in the database. Dump it to a file, and copy the file off the
server:

```bash
docker compose exec -T db pg_dump -U porchsite --clean --if-exists porchsite | gzip > porchsite-$(date +%F).sql.gz
```

Restore into the running stack (this replaces what's there):

```bash
gunzip -c porchsite-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U porchsite -d porchsite
docker compose restart app
```

Keep `.env` too (in a safe place: it holds the database password). Caddy's
certificates are in the `caddy_data` volume; losing them only means Caddy
fetches new ones.

## Admin commands

Run inside the app container: `docker compose exec app python -m server.app.cli <command>`.

| Command | What it does |
|---|---|
| `check` | database, schema, looks, settings; exit 1 on a problem |
| `setup-link [--hours N]` | prints a one-time link the owner opens to claim the site |
| `setup-code` | prints a fresh strong code for `PORCHSITE_SETUP_CODE` (changes nothing) |
| `token --name <assistant>` | mints an assistant's access token for this site |

## Notes

- Only Caddy is published; the app isn't reachable from outside the Compose
  network, and it trusts Caddy's forwarding headers.
- `www.example.com` gets a certificate too and redirects to `example.com`
  (the app does that: a passkey works only at the address where it was made).
- To stop: `docker compose down`. Add `-v` only if you mean to delete the
  site's data: it removes the database volume.
- Ports 80 and 443 taken on this machine? `PORCHSITE_HTTP_PORT` and
  `PORCHSITE_HTTPS_PORT` in `.env` move Caddy, but automatic certificates
  then need another proxy in front. Set `PORCHSITE_SITE_URL` if the site's
  address isn't `https://<domain>`.

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
