/** Fast dispatch for proven legacy forms; every other request uses the original handler. */
import { createMcpHandler } from "agents/mcp/server";
import { createServer, createToolHandlers, INSTRUCTIONS, TOOL_DEFINITIONS } from "./mcp";
import type { Env } from "./env";
import { withToolContext } from "./tool-context";
import { reportMcpDispatch } from "./mcp-dispatch-diagnostic";

const streamed = createMcpHandler(createServer, { route: "/mcp" });

/**
 * A client that accepts only JSON gets JSON, as from the server edition: the
 * MCP library answers a POST only as an event stream, so the stream's one
 * message is unwrapped here.
 */
async function originalMcp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

const listedResult = { tools: Object.entries(TOOL_DEFINITIONS).map(([name, definition]) => ({
  name,
  description: definition.description,
  inputSchema: { type: "object", ...definition.inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" }) },
  ...("annotations" in definition ? { annotations: definition.annotations } : {}),
})) };
const checks = new Map(Object.entries(TOOL_DEFINITIONS).map(([name, definition]) => {
  const check = definition.inputSchema.safeParse;
  check({});
  return [name, check] as const;
}));
const versions = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const cors = {
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

export async function toolTransport(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const fallback = () => { reportMcpDispatch("sdk"); return originalMcp(req, env, ctx); };
  // Header validation and all protocol extensions stay with the original handler.
  // The fast lane admits only the exact ordinary forms covered by the transcript.
  const accept = req.headers.get("Accept") ?? "";
  const version = req.headers.get("Mcp-Protocol-Version");
  if (req.method !== "POST" || req.signal.aborted || req.headers.has("Origin") ||
      !/^application\/json(?:;|$)/i.test(req.headers.get("Content-Type") ?? "") ||
      (accept.includes("text/event-stream") && !accept.includes("application/json")) ||
      (version !== null && !versions.has(version)) ||
      [...req.headers.keys()].some(name => name.startsWith("mcp-") && name !== "mcp-protocol-version" && name !== "mcp-session-id")) return fallback();
  const hostname = new URL(req.url).hostname;
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname) || hostname.endsWith(".workers.dev")) {
    const host = req.headers.get("Host");
    if (!host) return fallback();
    try {
      const allowed = hostname.endsWith(".workers.dev") ? [hostname] : ["localhost", "127.0.0.1", "[::1]"];
      if (!allowed.includes(new URL(`http://${host}`).hostname)) return fallback();
    } catch { return fallback(); }
  }
  let body: unknown;
  try { body = await req.clone().json(); } catch { return fallback(); }
  if (!record(body) || !only(body, ["jsonrpc", "id", "method", "params"]) || body.jsonrpc !== "2.0" ||
      typeof body.method !== "string" || !(typeof body.id === "string" || typeof body.id === "number") ||
      (typeof body.id === "number" && !Number.isSafeInteger(body.id)) ||
      (body.params !== undefined && !record(body.params))) return fallback();
  const params = body.params as Record<string, unknown> | undefined;
  let result: unknown;
  if (body.method === "initialize") {
    if (!params || !only(params, ["protocolVersion", "capabilities", "clientInfo"]) ||
        typeof params.protocolVersion !== "string" || !versions.has(params.protocolVersion) ||
        !record(params.capabilities) || Object.keys(params.capabilities).length ||
        !record(params.clientInfo) || !only(params.clientInfo, ["name", "version"]) ||
        typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") return fallback();
    result = { protocolVersion: params.protocolVersion, capabilities: {tools:{listChanged:true}}, serverInfo:{name:"porchsite",version:"0.0.1"}, instructions:INSTRUCTIONS };
  } else if (body.method === "tools/list") {
    if (params && Object.keys(params).length) return fallback();
    result = listedResult;
  } else if (body.method === "tools/call") {
    if (!params || !only(params, ["name", "arguments"]) || typeof params.name !== "string" ||
        (params.arguments !== undefined && !record(params.arguments))) return fallback();
    const check = checks.get(params.name);
    if (!check) return fallback();
    const parsed = check(params.arguments ?? {});
    if (!parsed.success) return fallback();
    const props = (ctx as unknown as {props?: Record<string, unknown>}).props ?? {};
    // A request's owner context lasts only for its callback, across awaited work.
    reportMcpDispatch("fast");
    try {
      result = await withToolContext(props, () => createToolHandlers().get(params.name as string)!(parsed.data));
    } catch (error) {
      // The original SDK turns unexpected callback errors into tool errors.
      result = {content:[{type:"text",text:error instanceof Error ? error.message : String(error)}],isError:true};
    }
    return response(result, body.id, accept);
  } else return fallback();
  reportMcpDispatch("fast");
  return response(result, body.id, accept);
}

function response(result: unknown, id: string | number, accept: string): Response {
  const json = JSON.stringify({result,jsonrpc:"2.0",id});
  return new Response(accept.includes("text/event-stream") ? `event: message\ndata: ${json}\n\n` : json, {
    headers: { ...cors, "Cache-Control":"no-cache, no-transform", Connection:"keep-alive", "Content-Type":accept.includes("text/event-stream")?"text/event-stream":"application/json", "X-Accel-Buffering":"no" },
  });
}
