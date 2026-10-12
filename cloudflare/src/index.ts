/**
 * The Worker. OAuthProvider owns the OAuth protocol endpoints and guards
 * /mcp; everything else (the site and the owner's pages) is routes.ts.
 *
 * Tokens are bound to the site's address. That's SITE_URL when set (use it
 * once you add a custom domain), otherwise the address the request came in on,
 * so a fresh workers.dev deploy works with no configuration.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { RELEASE } from "./home";
import { createServer } from "./mcp";
import { handle } from "./routes";

const mcp = createMcpHandler(createServer, { route: "/mcp" });
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
      apiHandler: { fetch: (req, env, ctx) => mcp(req, env, ctx) },
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
      return new Response(null, { status: 301, headers: { Location: u.href, "Cache-Control": "max-age=3600" } });
    }
    const origin = (env.SITE_URL || new URL(req.url).origin).replace(/\/$/, "");
    const res = await provider(origin).fetch(req, env, ctx);
    // Which release is running, on every answer.
    const out = new Response(res.body, res);
    out.headers.set("X-Porchsite-Release", RELEASE);
    return out;
  },
} satisfies ExportedHandler<Env & { SITE_URL?: string }>;
