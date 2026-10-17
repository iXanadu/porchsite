/** Exact-origin MCP boundary; OAuth routes never use this check. */
import { originValidationResponse } from "@modelcontextprotocol/server";
export const MCP_CORS = {
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};
export function mcpOriginRejection(req: Request, site: string): Response | undefined {
  const value = req.headers.get("Origin");
  if (value === null) return;
  try {
    if (value.endsWith(":") || !/^https?:\/\/[^/?#@\s\\,%]+$/i.test(value)) throw new Error();
    const actual = new URL(value), expected = new URL(site);
    if (expected.hostname.startsWith("www.")) expected.hostname = expected.hostname.slice(4);
    if (actual.origin === expected.origin) return;
  } catch { /* Malformed values fail closed. */ }
  // Keep the SDK's existing 403 JSON-RPC answer and CORS headers. The SDK
  // treats an empty Origin as absent; a present empty header is invalid here.
  const rejection = originValidationResponse(req, []) ?? Response.json({
    jsonrpc: "2.0", error: { code: -32000, message: "Invalid Origin header: " }, id: null,
  }, { status: 403 });
  const headers = new Headers(rejection.headers);
  for (const [name, value] of Object.entries(MCP_CORS)) headers.set(name, value);
  return new Response(rejection.body, { status: 403, headers });
}
