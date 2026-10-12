# Setting up your assistant for Porchsite

Porchsite works with any assistant that can read a web page. This page is
how to get the most out of the one you have: a few minutes of setup in its
app before you ask it for a site. Use everything your app offers; skip
what it doesn't. Nothing here is required.

What's below is what we found in each app in October 2026. Apps move their
menus often; if something isn't where we say, ask your assistant where its
app keeps it.

## The instructions to give it

Every app below has a place for standing instructions (a template, a
project, custom instructions, a skill). Put this in it:

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
- When you pick a look and colours for me, tell me which and why, and
  what else was on offer, so I can switch.
- My jobs are only the ones you can't do (my Cloudflare account, my
  passkey, adding a connector or key) and yes or no on the review page.
  Don't ask me to edit content or upload corrections: make the change
  and send it for approval.
- Never tell me a change is live before I've approved it.
```

## Grok Bot (xAI)

- **Install the Porchsite template.** Grok Bot installs ready-made bots
  from a link; the Porchsite one already carries the instructions above.
  Its link goes on porchsite.dev when it's published.
- **Add the Cloudflare plugin** from its plugin marketplace, with write
  access. Then it installs your site itself.
- Tokens and keys go in its secure paste box.

## Claude (Anthropic): the Claude app

- **Make a project** for your site and put the instructions above in its
  project instructions. Start every Porchsite conversation in it.
- **Add Cloudflare as a custom connector** (Settings, Connectors, add a
  custom connector) at `https://mcp.cloudflare.com/mcp`, and choose write
  access when Cloudflare asks. After the install, add your site the same
  way: `https://<your site>/mcp`.
- **Claude in Chrome** (a browser extension) lets Claude fill in forms in
  your own browser, such as the installer's; you still do the sign-ups and
  the passkey.

## ChatGPT (OpenAI)

- **Add a custom MCP server** in ChatGPT's plugin settings, signing in
  with OAuth: first Cloudflare's, `https://mcp.cloudflare.com/mcp`, then,
  after the install, your site's `https://<your site>/mcp`. Leave any
  bearer-token field empty for these: they sign in instead.
- Put the instructions above in its custom instructions, or a project for
  your site.

## Meta AI

- **Its credential vault** is where an assistant key goes: make the key on
  your site's Assistants page, and have Meta AI open its secure request
  for it, never paste it into the chat.
- Put the instructions above wherever it keeps standing instructions or
  skills.

## Any other assistant

Look for these four things in its app:

1. **Standing instructions**: a template, project, custom assistant, skill
   or "custom instructions". Put the instructions above in it.
2. **Custom connectors** (MCP servers, plugins, integrations) that sign in.
   Add Cloudflare's, `https://mcp.cloudflare.com/mcp`, with write access;
   not the "Cloudflare Developer Platform" connector some directories list,
   which can't upload the site. After the install, add your site's
   `https://<your site>/mcp`.
3. **A browser** it can use, its own or yours through an extension: it can
   fill in forms and check your site as a visitor sees it.
4. **A secret field** (secret, password, API key, credential) for tokens and
   keys, so they never go in the chat.

Without custom connectors, your assistant sends you to the one-page
installer (you make a Cloudflare token there), and connects to your site
with an assistant key in its secret field. Without either, it can still
hand you everything as one import file, once; after that you'll want an
assistant that can connect.

## After the site is up

Just talk to it: "add the photos from Saturday", "change the dinner time".
It drafts the change, and nothing goes live until you approve it on your
review page.
