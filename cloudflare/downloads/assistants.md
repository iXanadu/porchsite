# Setting up your assistant for Porchsite

Porchsite works with any assistant that can read a web page. This page is
for getting the most out of the one you have: a few minutes of setup in
your assistant's app before you ask it to build your site. Use whatever
your app offers; skip what it doesn't. Nothing here is required.

Apps change their menus often, so this describes what to look for, not
where to click. If you can't find something, ask your assistant where its
app keeps it.

## 1. Give it standing instructions

Most assistant apps have a place for instructions that apply to every
conversation, or to one project: a template you can install from a link,
a project, a custom assistant, a skill, or "custom instructions". If your
app has one, put this in it:

```
You help me run my Porchsite website. Before any Porchsite work, read
https://get.porchsite.dev/llms.txt in full, and follow it and the install
guide it links. If your fetch tool only summarises, read the raw copy it
names. Re-read them at the start of each new task: they change.

- If you can't make Cloudflare API calls yourself, send me to
  https://get.porchsite.dev/install/ instead of improvising.
- Connect to my site at https://<my site>/mcp: a connector that signs in
  first, an assistant key second, an import file only as a last resort.
- Never ask me to paste a token, key or code into the chat; use your
  app's secret field, or tell me you don't have one.
- My jobs are only the ones you can't do (my Cloudflare account, my
  passkey, adding a connector or key) and yes or no on the review page.
  Don't ask me to edit content or upload corrections: make the change
  and send it for approval.
- Never tell me a change is live before I've approved it.
```

If your app installs ready-made assistants from a link, there may be one
for Porchsite already; porchsite.dev lists the ones we know of.

## 2. Connect Cloudflare (if your app takes custom connectors)

If your app lets you add a custom connector (also called an MCP server,
plugin or integration) that signs in, add Cloudflare's own:
`https://mcp.cloudflare.com/mcp`. When Cloudflare asks what it may do,
choose write access: read-only can't install anything. With it, your
assistant installs the site itself and you only claim it.

Not the "Cloudflare Developer Platform" connector some apps list in their
directory: it can't upload the site.

No custom connectors? Your assistant will send you to the one-page
installer, which needs a Cloudflare token you make there. That works too;
it's one extra step for you.

## 3. Let it use a browser (optional)

Some apps let the assistant open web pages in a browser, its own or yours
through an extension. That lets it fill in forms and check your site as a
visitor sees it. You still do the parts only a person can: making the
Cloudflare account, verifying its email, making a token, and creating
your passkey.

## 4. Find its secret field

Tokens and keys go in a secret, password, API-key or credential field in
your app, never in the chat. Find it before you start, so your assistant
can collect them safely. If your app has none, your assistant should use
the one-page installer (you paste the token on that page) and a connector
that signs in (no key to paste at all).

## 5. After the site is up

Your assistant connects to your site at `https://<your site>/mcp`:
- If your app takes custom connectors that sign in, add one with that
  address and approve it with your passkey. This is the best way.
- If not, make your assistant a key on your site's Assistants page and
  put it in your app's secret field.

Then just talk to it: "add the photos from Saturday", "change the dinner
time". It drafts the change, and nothing goes live until you approve it
on your review page.
