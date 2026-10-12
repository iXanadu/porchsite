# Sitekeeper spec

Sitekeeper is a personal website that your AI assistant keeps up to date and
that never changes without your yes.

This folder is the contract every Sitekeeper implementation follows:

- **[SPEC.md](SPEC.md)**: roles, the safety rules, the content model, the
  assistant's MCP tools, the owner's approval, and the template format.
- **[conformance/](conformance/)**: point it at any Sitekeeper site with an
  assistant's token; it tries everything an assistant must not be able to do.
- **[TEMPLATES.md](TEMPLATES.md)**: how a template is built, the data it
  receives, the rules it must pass, and how to contribute one (draft).

Implementations:

| Folder | For | Runs on |
|---|---|---|
| `cloudflare/` | Everyone. Your assistant installs it; no server, free tier | Cloudflare Workers |
| `server/` | People who run their own host | Python + PostgreSQL |
