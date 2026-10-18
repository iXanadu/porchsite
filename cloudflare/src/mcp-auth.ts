/** MCP resource authentication refusal contract (SPEC §4, PAR-1). */
import { MCP_CORS } from "./mcp-origin";

export function mcpBearer(header: string | null): string | undefined {
  // Absolute end, plus the union of both runtimes' whitespace characters.
  return /^Bearer[\t ]+([^\s,\u0085\u001c-\u001f]+)(?![\s\S])/i.exec(header ?? "")?.[1];
}

export function mcpRefusal(origin: string, invalid: boolean, description?: string, response?: Response): Response {
  const headers = new Headers(response?.headers);
  headers.set("Cache-Control", "private, no-store, no-transform");
  headers.set("WWW-Authenticate", `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${invalid ? ', error="invalid_token"' : ''}, scope="site:draft"`);
  for (const name of ["ETag", "Last-Modified", "Age", "Location"]) headers.delete(name);
  for (const [name, value] of Object.entries(MCP_CORS)) if (!headers.has(name)) headers.set(name, value);
  const exposed = (headers.get("Access-Control-Expose-Headers") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  for (const name of ["mcp-session-id", "WWW-Authenticate"]) if (!exposed.some(value => value.toLowerCase() === name.toLowerCase())) exposed.push(name);
  headers.set("Access-Control-Expose-Headers", exposed.join(", "));
  if (!response && !invalid) headers.set("Pragma", "no-cache");
  let body: BodyInit | null = response?.body ?? null;
  if (!response && invalid) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify({error: "invalid_token", error_description: description});
  }
  return new Response(body, {status: 401, headers});
}

export function mcpPreflight(): Response {
  return new Response(null, {status: 204, headers: {
    ...MCP_CORS, "Access-Control-Expose-Headers": "mcp-session-id, WWW-Authenticate",
    "Cache-Control": "private, no-store, no-transform", "Content-Length": "0",
  }});
}
