import {withPreviewRequest,skipPublicPreparation} from './preview-auth';
/**
 * The Worker. OAuthProvider owns the OAuth protocol endpoints and guards
 * /mcp; everything else (the site and the owner's pages) is routes.ts.
 *
 * Tokens are bound to the site's address. That's SITE_URL when set (use it
 * once you add a custom domain), otherwise the address the request came in on,
 * so a fresh workers.dev deploy works with no configuration.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { oauthCors, OAUTH_PATHS } from "./oauth-cors";
import { mcpOriginRejection } from "./mcp-origin";
import { mcpBearer, mcpRefusal, mcpPreflight } from "./mcp-auth";
import { toolTransport } from "./tool-transport";
import type { Env } from "./env";
import { RELEASE } from "./home";
import { livePrivate } from "./privacy";
import * as keys from "./keys";
import * as readKeys from "./read-keys";
import { handle, preparePublic } from "./routes";

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
      defaultHandler: { fetch: (req, env, ctx) => handle(req, env as Env, ctx) },
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
  fetch(req:Request,env:Env,ctx:ExecutionContext){const u=new URL(req.url);return u.pathname==='/mcp'?withPreviewRequest(req,env,()=>fetchRequest(req,env,ctx,u)):fetchRequest(req,env,ctx,u);},
} satisfies ExportedHandler<Env & { SITE_URL?: string }>;
async function fetchRequest(req: Request, env: Env & { SITE_URL?: string }, ctx: ExecutionContext,u:URL) {
    // One address per site: a passkey works only where it was made, so
    // www.<domain> sends everyone to <domain>.
    const loopback = u.hostname === "localhost" || u.hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/.test(u.hostname);
    if (u.protocol === "http:" && !loopback) {
      u.protocol = "https:";
      return new Response(null, {status:301, headers:{Location:u.href, "Cache-Control":"no-store"}});
    }
    if (u.hostname.startsWith("www.")) {
      u.hostname = u.hostname.slice(4);
      return new Response(null, { status: 301, headers: { Location: u.href, "Cache-Control": await livePrivate(env.DB) ? "private, no-store, no-transform" : "max-age=3600" } });
    }
    const origin = (env.SITE_URL || new URL(req.url).origin).replace(/\/$/, "");
    let res: Response;
    const bearer = u.pathname === "/mcp" ? mcpBearer(req.headers.get("Authorization")) : undefined;
    const rejected = u.pathname === "/mcp" ? mcpOriginRejection(req, origin) : undefined;
    if (rejected) {
      res = rejected;
    } else if (u.pathname === "/mcp" && req.method === "OPTIONS") {
      res = mcpPreflight();
    } else if (u.pathname === "/mcp" && !bearer) {
      res = mcpRefusal(origin, false);
    } else if (u.pathname === "/mcp" && bearer && (bearer.startsWith(keys.PREFIX) || bearer.startsWith(readKeys.PREFIX))) {
      // An assistant key (keys.ts) instead of an OAuth token: the same tools.
      const who = await (bearer.startsWith(readKeys.PREFIX)?readKeys.lookup(env.DB,bearer):keys.lookup(env.DB, bearer));
      if (!who) {
        res = mcpRefusal(origin, true, "This key doesn't work: it was revoked, it expired, or it's mistyped.");
      } else {
        const keyed = { waitUntil: ctx.waitUntil.bind(ctx), passThroughOnException: ctx.passThroughOnException.bind(ctx), props: { ...who, origin } } as unknown as ExecutionContext;
        res = await toolTransport(req, env as Env, keyed);
      }
    } else if (
      u.pathname === "/mcp" || u.pathname.startsWith("/mcp/") ||
      u.pathname === "/.well-known/oauth-authorization-server" ||
      u.pathname === "/.well-known/oauth-protected-resource" || u.pathname.startsWith("/.well-known/oauth-protected-resource/") ||
      u.pathname === "/oauth/token" || u.pathname === "/oauth/register" ||
      u.pathname === "/authorize" || u.pathname === "/review" || u.pathname.startsWith("/review/")
    ) {
      res = await provider(origin).fetch(req, env, ctx);
    } else {
      // Public routes enter the same live access gate without constructing
      // OAuth helpers; consent and owner review retain the provider helpers.
      res = await handle(req, env as Env, ctx);
    }
    // The OAuth library validates tokens; this resource owns refusal headers.
    if (u.pathname === "/mcp" && res.status === 401) res = mcpRefusal(origin, !!bearer, undefined, res);
    if(!skipPublicPreparation()&&req.method==='POST'&&/^\/(?:review|mcp)(?:\/|$)/.test(u.pathname)&&res.status>=200&&res.status<400)ctx.waitUntil(preparePublic(env).catch(()=>{}));
    if(u.pathname==='/mcp'&&bearer?.startsWith(readKeys.PREFIX)){
      res=new Response(res.body,res);res.headers.set('Cache-Control','private, no-store, no-transform');
    }
    // Which release is running, on every answer.
    const out = oauthCors(u.pathname, new Response(res.body, res));
    if (req.method === "OPTIONS" && out.status === 204 && OAUTH_PATHS.has(u.pathname)) out.headers.delete("Content-Length");
    out.headers.set("X-Porchsite-Release", RELEASE);
    return out;
}
