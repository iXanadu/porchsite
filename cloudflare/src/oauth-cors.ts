/** Fixed non-credentialed sharing for OAuth protocol responses, SPEC §4. */
export const OAUTH_PATHS = new Set([
  "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp", "/oauth/token", "/oauth/register",
]);
export const OAUTH_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Retry-After, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};
export function oauthCors(path: string, response: Response): Response {
  if (!OAUTH_PATHS.has(path)) return response;
  const headers = new Headers(response.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith("access-control-")) headers.delete(name);
  for (const [name,value] of Object.entries(OAUTH_CORS)) headers.set(name,value);
  const vary = (headers.get("Vary") ?? "").split(",").map(value => value.trim()).filter(value => value && value.toLowerCase() !== "origin");
  if (vary.length) headers.set("Vary",vary.join(", "));else headers.delete("Vary");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
