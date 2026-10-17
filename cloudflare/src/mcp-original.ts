/** Original SDK handler and JSON-only adapter, with a same-origin browser boundary. */
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./mcp";
import { mcpOriginRejection } from "./mcp-origin";
import type { Env } from "./env";

const streamed = createMcpHandler(createServer, { route: "/mcp" });

/**
 * A client that accepts only JSON gets JSON, as from the server edition: the
 * MCP library answers a POST only as an event stream, so the stream's one
 * message is unwrapped here.
 */
async function mcp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rejected = mcpOriginRejection(req, (env as Env & { SITE_URL?: string }).SITE_URL || req.url);
  if (rejected) return rejected;
  if (req.headers.has("Origin")) {
    // Our stricter scheme/host/port check already accepted this Origin.
    // The SDK's hostname-only defaults cannot express it. Remove only the
    // accepted header for MCP; leave its Host/DNS-rebinding checks intact.
    const headers = new Headers(req.headers);
    headers.delete("Origin");
    req = new Request(req, { headers });
  }
  const accept = req.headers.get("Accept") ?? "";
  if (req.method !== "POST" || accept.includes("text/event-stream")) return streamed(req, env, ctx);
  const headers = new Headers(req.headers);
  headers.set("Accept", "application/json, text/event-stream");
  const res = await streamed(new Request(req, { headers }), env, ctx);
  if (!(res.headers.get("Content-Type") ?? "").includes("text/event-stream")) return res;
  const messages = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean);
  const out = new Headers(res.headers);
  out.set("Content-Type", "application/json");
  out.delete("Content-Length");
  return new Response(messages.length === 1 ? messages[0] : `[${messages.join(",")}]`, { status: res.status, headers: out });
}
export { mcp as originalMcp };
