/**
 * The Worker. OAuthProvider owns the OAuth protocol endpoints and guards
 * /mcp; everything else (the site and the owner's pages) is routes.ts.
 *
 * Tokens are bound to the site's address. That's SITE_URL when set (use it
 * once you add a custom domain), otherwise the address the request came in on,
 * so a fresh workers.dev deploy works with no configuration.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { toolTransport } from "./tool-transport";
import type { Env } from "./env";
import { RELEASE } from "./home";
import { livePrivate } from "./privacy";
import * as keys from "./keys";
import { handle } from "./routes";

const providers = new Map<string, OAuthProvider<Env>>();

function provider(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["site:draft"],
        resource_name: "Porchsite site",
      },
      apiRoute: "/mcp",
      apiHandler: { fetch: (req, env, ctx) => toolTransport(req, env, ctx) },
      defaultHandler: { fetch: (req, env) => handle(req, env as Env) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["site:draft"],
      accessTokenTTL: 3600,
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  async fetch(req: Request, env: Env & { SITE_URL?: string }, ctx: ExecutionContext) {
    // One address per site: a passkey works only where it was made, so
    // www.<domain> sends everyone to <domain>.
    const u = new URL(req.url);
    if (u.hostname.startsWith("www.")) {
      u.hostname = u.hostname.slice(4);
      return new Response(null, { status: 301, headers: { Location: u.href, "Cache-Control": await livePrivate(env.DB) ? "private, no-store" : "max-age=3600" } });
    }
    const origin = (env.SITE_URL || new URL(req.url).origin).replace(/\/$/, "");
    let res: Response;
    const bearer = /^Bearer[\t ]+(psk_[A-Za-z0-9_-]+)$/i.exec(req.headers.get("Authorization") ?? "");
    if (u.pathname === "/mcp" && bearer) {
      // An assistant key (keys.ts) instead of an OAuth token: the same tools.
      const who = await keys.lookup(env.DB, bearer[1]);
      if (!who) {
        res = new Response(JSON.stringify({ error: "invalid_token", error_description: "This key doesn't work: it was revoked, it expired, or it's mistyped." }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      } else {
        const keyed = { waitUntil: ctx.waitUntil.bind(ctx), passThroughOnException: ctx.passThroughOnException.bind(ctx), props: { ...who, origin } } as unknown as ExecutionContext;
        res = await toolTransport(req, env as Env, keyed);
      }
    } else {
      res = await provider(origin).fetch(req, env, ctx);
    }
    // Which release is running, on every answer.
    const out = new Response(res.body, res);
    out.headers.set("X-Porchsite-Release", RELEASE);
    return out;
  },
} satisfies ExportedHandler<Env & { SITE_URL?: string }>;
