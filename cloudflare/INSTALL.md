# Installing Porchsite (for the assistant)

You are an AI assistant installing Porchsite on your person's own Cloudflare
account. Follow these steps in order. Every step is one Cloudflare API call;
nothing needs git, a terminal or a build tool. When a step says "tell your
person", say it in plain words and wait for them.

Read this file whole, word for word: the steps depend on exact values. It
may be copied in full (MIT licence). If your fetch tool only returns a
summary, or can't reach this address, the same file is at
https://raw.githubusercontent.com/iXanadu/porchsite/main/cloudflare/INSTALL.md

Is your person a developer who'd rather run it themselves? Read
[self-hosting](https://get.porchsite.dev/self-hosting.md) first.

(The site's file is `sitekeeper.js` and its layout table `_sitekeeper_migrations`:
Sitekeeper is the engine's internal name, kept in those names so every site
stays updatable. Everything else is Porchsite.)

**Three rules for the whole job.**
- Only ever upload a release's own `sitekeeper.js`, its hash checked. Never
  change the site's code, add a logging or helper Worker to it, or put a
  temporary page on it, not even for a minute to debug: your person
  approves what the site says, and that rests on the site being the
  release.
- Codes are secrets while they live (the setup code, an OAuth code, a PKCE
  verifier, a token). Never type one into another site, a search box or a
  form that isn't the one it belongs to.
- When you write content later, finish the whole job and send it for
  approval as one request, not a piece at a time; and tell your person
  each time there's something waiting at `/review`, with the link. Drafts
  are invisible to them until you do.
- Content goes in only through the site's own tools at `/mcp` (step 9),
  never by writing its database, which skips the checks the site runs on
  every change (secrets, private names, field rules, copying in images).
  The only things you ever write to the database are the release's
  migration files and their `_sitekeeper_migrations` rows (steps 3 and
  Updating). Never copy code, data or pictures from another site, even
  one on the same account: install from the release's files.

Read this guide in full, as plain text, from
`https://get.porchsite.dev/install.md`. A fetch tool that summarises pages
drops steps; if yours does, ask your person to paste the guide in, or use
the copy in the repository (`cloudflare/INSTALL.md` at
https://github.com/iXanadu/porchsite).

Get the files from `https://get.porchsite.dev/latest.json`. It lists
the current `version` and its `files`, each
`{"path": "sitekeeper.js", "url": "…", "bytes": 1635400, "sha256": "…"}`:
`sitekeeper.js` (the site) and `migrations/*.sql` (the database layout).
Download each one and check its sha256 (hex, of the file's bytes) before you
use it. Tell your person which version you installed. If your network can't
reach get.porchsite.dev, every file also has a `mirror`: the same bytes on
the project's GitHub releases (check the same sha256). Each past release's
files and hashes are at its `files_url` in `releases`.

**Moving the files.** `sitekeeper.js` is about 1.6 MB, and step 6 sends it to
Cloudflare. Fetch it with your own web or shell tool, then send it with an
HTTP tool that can carry a file or a long body. Cloudflare's MCP `execute`
sandbox can't fetch outside addresses itself (it refuses get.porchsite.dev),
so if that's your route you
must pass the file's contents into the call, inlined in the request body
(step 6 shows the exact shape; some apps let you reference a local file in a
tool's arguments). If you can do neither, ask your person for an API token
(step 0) and use your own HTTP tool for steps 3 and 6.

List calls (`GET` of databases, namespaces, zones) return a page at a time:
add `?per_page=50` and check `result_info` for more.

## 0. Access

**No Cloudflare access of your own?** Don't improvise one. Send your person
to `https://get.porchsite.dev/install/`: they make a token there from a
pre-filled link, paste it with the site's name, and the page does steps
2 to 7 and gives them the claim link. Then pick up at step 9 (connect
yourself). Skip the rest of this section.

Calls go to `https://api.cloudflare.com/client/v4` with your Cloudflare
access: either Cloudflare's own API MCP server, `https://mcp.cloudflare.com/mcp`
(its `search` and `execute` tools reach the whole API), or an API token
your person made. Not the "Cloudflare Developer Platform" connector some
apps list in their directory: that one manages databases and storage but
can't upload a Worker, so the install stops at step 6. If your person has
to add the right one, it's a custom connector with that address. If it's a token, collect it through your app's
secret or password field, never in the chat, and never write it into a
memory, a note or a file. The access must be able to **edit** Workers scripts,
D1 and Workers KV.

For a token, send your person this pre-filled link (signed in to Cloudflare;
if the form opens empty, open it again):
https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&name=Porchsite
It asks for four account permissions: Workers Scripts Edit, D1 Edit,
Workers KV Storage Edit, Account Settings Read. Not the "Edit Cloudflare
Workers" template: it adds a zone row that a new account, with no domain,
can't fill, and it leaves out D1. If you connected through Cloudflare's MCP server, your
person had to choose write access on its consent screen; read-only is the
default and will fail at step 2.

Find the account: `GET /accounts`. If there is more than one, ask your person
which. Call its id `ACCOUNT` below. Note the time now, in UTC (`START`): the
last check lists what changed on the account since.

Through Cloudflare's MCP server, `execute` can also take an account id. If
your session has only one account, leave it out: passing it has sometimes
failed with error 7403 ("account not valid or not authorized") where the
same call without it worked. If you get 7403, retry once without it.

## 1. Pick a name, and the address, with your person

Ask before you create anything: what is the site for, and where should it
live? Either a free address, `https://<name>.<subdomain>.workers.dev`, or
their own domain (step 7b; one they have, or about $10 a year for a new
one). Suggest a name that fits the site (a reunion: the school and the
year), not `porchsite`. Call it `NAME`. Settle it now: the passkey your
person makes in step 8 works only at the address where they make it, so a
later move means a re-link (see "Moving to a new address later").

## 2. Database

`POST /accounts/ACCOUNT/d1/database` with `{"name": "NAME"}`.
Keep `result.uuid` as `DB`.

Already exists (error code 7502)? `GET /accounts/ACCOUNT/d1/database?name=NAME`
and use that one's uuid. Never delete a database to start over: it holds the
site.

## 3. Database layout

Porchsite records which layout files it has applied, so this step is safe to
repeat. First:

`POST /accounts/ACCOUNT/d1/database/DB/query` with
`{"sql": "CREATE TABLE IF NOT EXISTS _sitekeeper_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"}`

Then `{"sql": "SELECT name FROM _sitekeeper_migrations"}`; the names are at
`result[0].results[].name`. For each file in
`migrations/` (latest.json's `all_migrations`, in that order) that is not in
that list: send the file's whole
text as `sql` to the same endpoint, and when it succeeds, record it:
`{"sql": "INSERT INTO _sitekeeper_migrations VALUES (?, datetime('now'))", "params": ["0001_init.sql"]}`.
If a file fails, stop and show your person the error; do not record it.
A file may hold several statements; one call runs them all.

## 4. Sign-in storage

`POST /accounts/ACCOUNT/storage/kv/namespaces` with `{"title": "NAME-oauth"}`.
Keep `result.id` as `KV`. Already exists? List them
(`GET /accounts/ACCOUNT/storage/kv/namespaces`) and use the one with that title.

## 5. Setup code

Make a random code of at least 16 letters and digits. Call it `CODE`. Your
person never types it: in step 8 you send them a link with it inside, and
they claim the site from that link. Don't put it anywhere but
step 6 and your message in step 8. If you must keep it in a file meanwhile,
delete the file once your person has claimed the site, and delete any file
you built for step 6's upload too: it contains the code.

## 6. Upload the site

`PUT /accounts/ACCOUNT/workers/scripts/NAME` as `multipart/form-data` with
two parts:

- `metadata` (`application/json`):
  ```json
  {
    "main_module": "sitekeeper.js",
    "compatibility_date": "2026-08-15",
    "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
    "bindings": [
      {"type": "d1", "name": "DB", "id": "DB"},
      {"type": "kv_namespace", "name": "OAUTH_KV", "namespace_id": "KV"},
      {"type": "secret_text", "name": "SETUP_CODE", "text": "CODE"}
    ],
    "observability": {"enabled": true}
  }
  ```
  with your `DB`, `KV` and `CODE` values in place of the quoted names.
- `sitekeeper.js` (`application/javascript+module`): the file's contents,
  with that part name and filename.

If your tool can't build `multipart/form-data` itself, write the body as
text: pick a boundary (e.g. `----porchsite`), then for each part a line
`------porchsite`, its headers (`Content-Disposition: form-data;
name="metadata"` or `name="sitekeeper.js"; filename="sitekeeper.js"`, and
`Content-Type`), a blank line and the content; end with `------porchsite--`.
Send it raw (not JSON-encoded) with the header `Content-Type:
multipart/form-data; boundary=----porchsite`. Use CRLF (`\r\n`) line ends.

**If you call the Cloudflare API through Cloudflare's MCP server**, its
`execute` tool runs your code, and the upload must go through its request
helper as that raw multipart text: the whole of `sitekeeper.js` inlined in
the body, `rawBody: true` so the helper sends the body as is instead of
encoding it as JSON, and `contentType` carrying the boundary. The exact
shape:

```js
async () => {
  const B = "----porchsite";
  const METADATA = { /* step 6's metadata, with your values */ };
  const BUNDLE = "…"; // sitekeeper.js's whole text, as a JSON string literal
  const body = [
    `--${B}`,
    'Content-Disposition: form-data; name="metadata"',
    "Content-Type: application/json",
    "",
    JSON.stringify(METADATA),
    `--${B}`,
    'Content-Disposition: form-data; name="sitekeeper.js"; filename="sitekeeper.js"',
    "Content-Type: application/javascript+module",
    "",
    BUNDLE,
    `--${B}--`,
    "",
  ].join("\r\n");
  return cloudflare.request({
    method: "PUT",
    path: "/accounts/ACCOUNT/workers/scripts/NAME",
    contentType: `multipart/form-data; boundary=${B}`,
    rawBody: true,
    body,
  });
}
```

Inline the bundle as a JSON string literal (escape it as JSON would), never
in a template literal: the bundle contains backticks and `${`. Without
`rawBody: true`, or with a `contentType` that lacks the boundary, Cloudflare
can't read the parts and refuses the upload. Other calls (JSON bodies, GETs,
DELETEs) go through the same helper with `method`, `path` and, for JSON,
`body` as an object.

Updating later is the same call; see "Updating" at the end.

## 7. Turn on the address

Every account has one workers.dev name, shared by all its Workers: the site's
address is `https://NAME.<that name>.workers.dev`. Most people use their own
name or nickname, e.g. `sam` gives `https://porchsite.sam.workers.dev`.

1. `GET /accounts/ACCOUNT/workers/subdomain`. If it returns a `subdomain`,
   keep it. On a new account it fails with HTTP 404, error code 10007 ("You
   do not have a workers.dev subdomain"). That is expected, not a problem,
   and you don't need the dashboard it mentions: ask your person to pick a
   short name, then `PUT /accounts/ACCOUNT/workers/subdomain` with
   `{"subdomain": "<their pick>"}`. Taken? Ask for another.
2. `POST /accounts/ACCOUNT/workers/scripts/NAME/subdomain` with
   `{"enabled": true, "previews_enabled": false}` (preview addresses for
   each upload are on by default; the site doesn't need them).

The site is `https://NAME.<subdomain>.workers.dev`. A brand-new address
takes a minute or two to answer: request `https://…/setup` every 20 seconds,
treat connection or TLS errors as "not ready yet", and go on once it answers
200. Don't send your person there before that.

## 7b. A free address, or their own domain

Ask your person now, before step 8, in plain words:

> "Your site can live at the free address `https://NAME.<subdomain>.workers.dev`,
> or at a domain you own, like `yourname.com`. A domain costs about $10 to $15
> a year. Which would you like? You can add a domain later, but it's simpler now."

Settle it here. A passkey works only at the address it was made on, so your
person must claim the site at its final address in step 8.

**Free address:** nothing to do; go to step 8.

**Their own domain:** find out which case it is, then follow that path.

**A. The domain is already on this Cloudflare account.**
`GET /zones?name=<domain>` returns it. Keep `result[0].id` as `ZONE` and
attach it (below).

**B. They own the domain, but it's registered somewhere else** (GoDaddy,
Namecheap, Squarespace, …).
1. Add it to Cloudflare: `POST /zones` with
   `{"name": "<domain>", "account": {"id": "ACCOUNT"}, "type": "full"}`. Keep
   `result.id` as `ZONE` and `result.name_servers` (two names).
2. Tell your person: "Sign in where you bought the domain, find its
   nameservers, and replace them with these two: …". Offer to walk them
   through it step by step for their registrar. If the domain already runs
   email or another site, warn them first: Cloudflare copies the existing DNS
   records it finds, but they should check those records before switching.
3. Wait. `GET /zones/ZONE` until `status` is `active`. It usually takes
   minutes, but can take up to a day. `PUT /zones/ZONE/activation_check` asks
   Cloudflare to look again (once an hour at most). Tell your person how long
   it's been, and stay with step 7b until it's active.

**C. They don't have a domain yet.** Cloudflare sells domains at cost. Tell
your person: "In the Cloudflare dashboard, open Domain Registration, then
Register Domains, search for the name you want, and buy it. I can't buy it
for you." Once it shows in `GET /zones?name=<domain>`, carry on as in case A.

**Attach it.** The site lives at the bare domain (`sam.com`, not
`www.sam.com`). `PUT /accounts/ACCOUNT/workers/domains` with
`{"hostname": "<domain>", "service": "NAME", "zone_id": "ZONE"}`, then the
same call with `"hostname": "www.<domain>"`, so people who type www still
arrive: the site sends them on to the bare domain. Cloudflare
creates the DNS record and the certificate itself. If the hostname already
has a DNS record (an old site, a parking page), the call fails. Show your
person the error, and don't delete their record without asking.

A new domain takes a few minutes to answer. Request `https://<domain>/setup`
every 30 seconds, treat connection or TLS errors as "not ready yet", and go on
once it answers 200. From here on, the site's address is `https://<domain>`;
use it in every step below. `www.<domain>` can take a few minutes longer
than the bare domain to get its certificate; that's normal.

Access for this step: adding and attaching a domain needs **Zone: Edit**,
**DNS: Edit** and **Workers Routes: Edit** on top of step 0's access. If a
call is refused for permissions, tell your person which one to add to the
token (or to choose on Cloudflare's consent screen), and wait.

## 8. Your person claims it

Send your person the link `https://…/setup?code=CODE` and tell them: "Your
site is ready. Open this link, add your name, and tap Create my passkey. That
passkey is how you approve what I write." The page fills the code in; they
need no terminal and no code to type. Wait until they say it's done. (If the
link is lost, the same link works until the site is claimed; once it is
claimed, the link only leads to sign-in.)

Then, at once:

**Delete the SETUP_CODE secret.** `DELETE
/accounts/ACCOUNT/workers/scripts/NAME/secrets/SETUP_CODE`. The site no
longer needs it. It stays stored until you delete it: uploading again
without the `SETUP_CODE` binding does **not** remove it. Deleting it is the
only way.

Check: `GET /accounts/ACCOUNT/workers/scripts/NAME/secrets` lists the
script's secrets (`result[].name`). None may be named `SETUP_CODE`. If one
is, delete it again and check again.

## 9. Connect yourself

Tell your person to add a connector in their assistant settings with the
address `https://…/mcp`, then approve it on the page that opens. Their
assistant app may ask them to confirm twice: once in the app, once on the
site's own page with their passkey. Both are expected. After that,
use the tools it gives you; start with the one that describes the site.

If your app can't add a connector that signs in (or its sign-in fails),
use an assistant key instead: ask your person to open
`https://…/review/assistants`, make a key named for you, and put it in your
app's secret or API-key field, never in the chat. Send it to
`https://…/mcp` as `Authorization: Bearer <key>` (JSON-RPC over HTTP, MCP's
streamable transport; it answers plain JSON if you accept only
`application/json`). The tools and limits are the same. From your own
code, send a User-Agent naming your app: Cloudflare refuses some library
defaults (Python's urllib) with "error code: 1010" before the site sees
them.

If you can't reach the site at all, write the content as one file and give
it to your person to upload at `https://…/review/import`:
`{"porchsite_import": 1, "from": "<your name>", "note": "<for your person>",
"items": [{"kind": "entry", "data": {...}}, ...], "images": {"hall.jpg":
"<base64>"}}`. Use `image:hall.jpg` wherever a picture goes (a cover, or
`![what it shows](image:hall.jpg)` in a body). Each item's `data` is what
`item_create` takes; a `site` item changes only the fields it names. It's
checked like your drafts and waits for their approval.

The import is a last resort for a first delivery. Keeping the site up is
your job, through `/mcp`: connect as above (sign-in or an assistant key)
before you call the work done. Never ask your person to edit content, fill
in fields or upload corrections; they approve or reject, and you do the
rest.

## 10. Pick a look

A new site shows the built-in look: plain on purpose, and the fallback if a
look ever goes missing. Don't leave it there. The look and its colours are
your person's to choose, so show them the choice, one way or the other:

- **Ask**, if they're happy to be asked: what the site is for (a personal
  page, a product, a local business, an event, …), then `theme_list` and
  two or three looks that fit, each with its demo link, and the palettes
  `theme_needs` lists for the one they pick.
- **Pick, then tell**, if they asked you not to stop with questions: choose
  the best fit and a palette yourself, and say in your approval note (and
  to them) which you chose and why, with the other looks and palettes on
  offer and their demo links, and that switching is one more approval.

The bundled looks are ready to use: `theme_list` marks them `source: built-in`
in `installed`. No `theme_install` is needed for those looks. Use it only
for a catalog look missing from `installed`, or to update an installed look.

Either way: set the site item's `theme` (and `palette`) to the chosen look,
call `theme_needs` and fill what it asks for (words and pictures), then ask
for approval. Nothing changes for visitors until they approve.

## Check

- `GET https://…/` answers with the site.
- `GET https://…/setup` after step 8 sends you to `/login`: the site is claimed.
- `GET /accounts/ACCOUNT/workers/scripts/NAME/secrets` lists no secret named
  `SETUP_CODE` (step 8).
- Nothing you write shows on the site until your person approves it at
  `https://…/review`. That is on purpose.
- **What changed on the account.** `GET
  /accounts/ACCOUNT/audit_logs?since=START&per_page=100` lists every change
  since you began (each with `when`, `action.type`, `resource.type` and
  `resource.id`, and `actor`). Match each one to a step you ran: the
  database, the sign-in storage, the upload, the secret and its removal,
  the address. Tell your person, in plain words, about any change you
  didn't make; don't undo it yourself. The log can lag by 15 minutes or
  more, so a step of yours missing from it isn't a problem; what matters is
  a change you didn't make. If the call is refused (your access can't read
  audit logs), say you couldn't check this, and go on.

## Images

Shrink pictures before sending: web size, about 2400 pixels on the long side, usually under 1 MB (JPEG or WebP). Sending the original is possible, but tell your person first, plainly: bigger files use more of the free plan's limits, make pages slower and take more storage.

Prepare the web-size copy yourself before posting a file to an upload link;
a direct file upload does not resize it. On the phone page, use the options
shown by the installed site. If resizing is unavailable, choose a copy you
have already shrunk. This advice also applies to older releases.

Image fields (the site's `hero`, an entry's `cover`, a card's `image`) and
Markdown images in an entry's body take a full https:// link to a JPEG, PNG
or WebP, up to 8 MB. The site copies the image in when you save, and the item
then holds a `/media/...` path instead; reuse that path freely. Every image
needs a few words saying what it shows (`hero_alt`, `cover_alt`, `image_alt`,
or the text in `![...]`).

A photo your person sent you: call `photo_upload_link`, then POST the file to
the `url` it returns as `multipart/form-data`, with fields `photo` (the file)
and `alt` (what it shows), and header `Accept: application/json`. The answer
holds `image`, the path to use. The link works once, for 30 minutes. If you
can't send files, give the link to your person instead: the page lets them
pick the photo on their phone, and
`photo_upload_status` tells you when it's done.

## Moving to a new address later

If the site was claimed at one address and later gets a domain, your person's
passkey won't work at the new one. Attach the domain as in step 7b, then tell
your person: "Sign in at the old address, open Passkeys, and make a link.
Open it at the new address and save a passkey there." Then they reconnect you
at `https://<domain>/mcp`.

Keep the old address working until your person has signed in at the new one
with the new passkey. Taking it away first locks them out of their own site.

## Updating

Porchsite never updates itself, and you never update it on your own: your
person decides. Every release stays downloadable, and every release is
checked before it is published so that the one before it runs on its
database too. That makes an update safe to try and a rollback one upload.

**Knowing there is one.** `site_state` returns `update`. When
`update.available` is true it also has `latest` (the newest release),
`security`, `changes`, `migrations`, `reconnect` and `how` (this section).
Your person's review page shows a line too. You can also read
`https://get.porchsite.dev/latest.json` yourself: `version`, `changes`,
`security`, `migrations` (the database files new in that release only),
`all_migrations` (every database file, in the order to apply them, each
`{"name", "url", "sha256"}`), `reconnect`, `files`, and `releases` (every
release, newest first). The whole history in plain words is at
`https://get.porchsite.dev/changelog/`.

**A security release** has `security: true` (in `update`, in latest.json
and in its changelog entry; `update.security` is true when any release
since the one running is). Say so first, in those words, and suggest doing
it soon. It is still your person's call.

### Ask

Tell your person, in plain words: which release they run (`release` in
`site_state`) and which is new, the `changes` lines (put them in your own
words if that helps), whether it's a security release, whether you'll need
to be reconnected afterwards (`reconnect`), and that nothing on the site
changes until you do it. Then ask. No yes, no update.

### Update (on a yes)

Note first: `RUNNING`, the release running now (`site_state.release`, or the
`X-Porchsite-Release` header). That is where a rollback goes back to.

1. **Download** `sitekeeper.js` from latest.json's `files`, and the
   database files you need (step 2). Each entry in `files` is
   `{"path", "url", "bytes", "sha256"}`, the same shape as
   `https://get.porchsite.dev/v/<release>/files.json`
   (`{"version": "<release>", "files": [...]}`). Check each file's `sha256`
   (hex, of the file's bytes). Any mismatch: stop and tell your person;
   don't upload anything.
2. **Database files first.** Don't rely on `migrations`: it lists only the
   newest release's new files, and your person may have skipped releases.
   Read what the site has applied, from its D1 database:
   `POST /accounts/ACCOUNT/d1/database/DB/query` with
   `{"sql": "SELECT name FROM _sitekeeper_migrations ORDER BY name"}`
   (the names are at `result[0].results[].name`). Then for **every** file
   in latest.json's `all_migrations` that is not in that list, in the
   order listed: download it from its `url`, check its `sha256`, send its
   whole text as `sql` to the same endpoint, and when it succeeds record it
   (`{"sql": "INSERT INTO _sitekeeper_migrations VALUES (?, datetime('now'))", "params": ["<name>"]}`).
   They only add tables and columns, so the release still running keeps
   working while you do this. If one fails, stop: don't record it, don't
   apply the later ones and don't upload. Show your person the error; the
   site is unchanged and still running `RUNNING`.
3. **Upload** as in step 6, with the same `DB` and `KV`, and without the
   `SETUP_CODE` binding (the site is claimed). The content stays as it is.
4. **Delete the SETUP_CODE secret** if it is still there. Leaving the
   binding out of the upload does **not** remove it. List the secrets:
   `GET /accounts/ACCOUNT/workers/scripts/NAME/secrets`. If one is named
   `SETUP_CODE`: `DELETE
   /accounts/ACCOUNT/workers/scripts/NAME/secrets/SETUP_CODE`.
5. **Verify.** `GET https://…/` answers 200 with an `X-Porchsite-Release`
   header naming the new release. The old release's header can show for a
   few seconds after an upload while it reaches everywhere: retry for up to
   30 seconds before you call it a failure. `GET
   /accounts/ACCOUNT/workers/scripts/NAME/secrets` lists no secret named
   `SETUP_CODE`. Then call `site_state`: `release` is the new id. It can
   still name the old one for a few seconds after the header has changed,
   so retry it for up to 30 seconds too. `update.available` is false (that
   part can lag a day: the site checks once a day). The owner's `/review` page still opens for them.
6. **Reconnect** if `reconnect` was true: tell your person to remove the
   site's connector in their assistant app and add it again (same address,
   `https://…/mcp`), so you see the new tools.
7. **Tell your person** it's done, and which release is running.

### Roll back

Before uploading, run `python3 scripts/check-private-downgrade --site https://example.com --target RELEASE` (replace both placeholders). Stop on its warning unless the owner explicitly confirms the exposure. See "Private sites, recovery and rollback" below.

If the new release misbehaves, put the previous one back. There is no
database step: the database files only ever add, and every release is
checked against the next one's database before it's published.

1. Download the previous release's bundle from
   `https://get.porchsite.dev/v/RUNNING/sitekeeper.js` (`RUNNING` from
   above) and check its sha256 against
   `https://get.porchsite.dev/v/RUNNING/files.json`, which lists every
   file of that release with its hash:
   `{"version": "RUNNING", "files": [{"path": "sitekeeper.js", "url": "…", "bytes": …, "sha256": "…"}, …]}`.
   Use the entry whose `path` is `sitekeeper.js`. Every release is there,
   for good.
2. Upload it as in step 6 (same bindings). Do **not** remove database files
   or tables, and don't run step 3.
3. Verify as above: `X-Porchsite-Release` names `RUNNING` again (retry for
   up to 30 seconds).
4. Reconnect if the release you're leaving had `reconnect: true`.
5. Tell your person what happened, and report the problem at
   [porchsite.dev/ask](https://porchsite.dev/ask) if they agree.

## Private sites, recovery and rollback

A look does not make a site private. Propose `site.private: true` separately;
only the owner can approve it. A private site's visitors get a blank page,
including feeds, search, sitemap and media. The blank response deliberately
uses HTTP status 404 so search engines and link previews treat it as absent.
Invite readers through
`/review/readers`; each saves their own passkey. Reader access is published
pages only. Revoking ends authorizations made after it commits, including
old sessions; already delivered or authorized in-flight copies remain.
Search-engine copies and pictures fetched before private mode also remain.

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

The code is random and stored only as a hash with an expiry. A new link
invalidates the previous link. Hosting-account access already grants control
of the site; recovery does not protect against a compromised hosting account.
