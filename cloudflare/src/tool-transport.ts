import {withPreviewRequest,markPreviewRead} from './preview-auth';
import * as readKeys from "./read-keys";
/** Fast dispatch for proven legacy forms; every other request uses the original handler. */
import { MCP_CORS as cors } from "./mcp-origin";
import { originalMcp } from "./mcp-original";
import { createToolHandlers, INSTRUCTIONS, TOOL_DEFINITIONS } from "./mcp";
import type { Env } from "./env";
import { withToolContext } from "./tool-context";
import { reportUploadPhase } from "./upload-diagnostic";
import { reportMcpDispatch } from "./mcp-dispatch-diagnostic";
import { IMAGE_INPUT_RELEASE, type OwnedImageInput } from "./image-add";

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

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

/** Equivalent to the two optional fields in image_add's immutable schema. */
function imageArguments(args: Record<string, unknown>) {
  if (args.data !== undefined && typeof args.data !== "string") return undefined;
  if (args.images !== undefined && (!Array.isArray(args.images) || args.images.length < 1 || args.images.length > 8 || args.images.some(value => typeof value !== "string"))) return undefined;
  return { success: true as const, data: {
    ...(args.data !== undefined ? {data: args.data} : {}),
    ...(args.images !== undefined ? {images: args.images} : {}),
  } };
}

export function toolTransport(req:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
 return withPreviewRequest(req,env,()=>dispatch(req,env,ctx));
}
async function dispatch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const fallback = () => { reportMcpDispatch("sdk"); return originalMcp(req, env, ctx); };
  // Header validation and all protocol extensions stay with the original handler.
  // The fast lane admits only the exact ordinary forms covered by the transcript.
  const accept = req.headers.get("Accept") ?? "";
  const version = req.headers.get("Mcp-Protocol-Version");
  if (!["", "*/*", "application/json", "text/plain", "application/json, text/event-stream"].includes(accept) ||
      req.method !== "POST" || req.signal.aborted || req.headers.has("Origin") ||
      !/^application\/json(?:; charset=utf-8)?$/i.test(req.headers.get("Content-Type") ?? "") ||
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
  reportUploadPhase("json", "start");
  try { body = await req.clone().json(); } catch { return fallback(); }
  finally { reportUploadPhase("json", "end"); }
  if (!record(body) || !only(body, ["jsonrpc", "id", "method", "params"]) || body.jsonrpc !== "2.0" ||
      typeof body.method !== "string" || !(typeof body.id === "string" || typeof body.id === "number") ||
      (typeof body.id === "number" && !Number.isSafeInteger(body.id)) ||
      (body.params !== undefined && !record(body.params))) return fallback();
  const params = body.params as Record<string, unknown> | undefined;
  if(body.method==='tools/call'&&params?.name==='preview_read')markPreviewRead();
  const props=(ctx as unknown as {props?:Record<string,unknown>}).props??{};
  if(readKeys.restricted(props))await readKeys.authorize(env.DB,props);
  let result: unknown;
  if (body.method === "initialize") {
    if (!params || !only(params, ["protocolVersion", "capabilities", "clientInfo"]) ||
        typeof params.protocolVersion !== "string" || !versions.has(params.protocolVersion) ||
        !record(params.capabilities) || Object.keys(params.capabilities).length ||
        !record(params.clientInfo) || !only(params.clientInfo, ["name", "version"]) ||
        typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") return fallback();
    result = { protocolVersion: params.protocolVersion, capabilities: {tools:{listChanged:true}}, serverInfo:{name:"porchsite",version:"0.0.1"}, instructions:readKeys.restricted(props)?readKeys.INSTRUCTIONS:INSTRUCTIONS };
  } else if (body.method === "tools/list") {
    if (params && Object.keys(params).length) return fallback();
    result = readKeys.restricted(props)?{tools:listedResult.tools.filter(t=>readKeys.ALLOWED.has(t.name))}:listedResult;
  } else if (body.method === "tools/call") {
    if (!params || !only(params, ["name", "arguments"]) || typeof params.name !== "string" ||
        (params.arguments !== undefined && !record(params.arguments))) return fallback();
    const check = checks.get(params.name);
    if (!check) return fallback();
    const args = params.arguments as Record<string, unknown> | undefined ?? {};
    const parsed = params.name === "image_add" ? imageArguments(args) ?? check(args) : check(args);
    if (!parsed.success) return fallback();
    const id = body.id;
    const name = params.name;
    if (name === "image_add") {
      const input = parsed.data as OwnedImageInput;
      Object.defineProperty(input, IMAGE_INPUT_RELEASE, { configurable: true, value: () => {
        delete input.data;
        delete input.images;
        delete input[IMAGE_INPUT_RELEASE];
      } });
      delete args.data;
      delete args.images;
      body = undefined;
      // No later branch can use SDK fallback. Do not await cancellation of a tee.
      try { void req.body?.cancel().catch(() => {}); } catch { /* cleanup cannot change the tool result */ }
    }
    const props = (ctx as unknown as {props?: Record<string, unknown>}).props ?? {};
    // A request's owner context lasts only for its callback, across awaited work.
    reportMcpDispatch("fast");
    try {
      await readKeys.authorize(env.DB,props,name);
      result = await withToolContext(props, () => createToolHandlers().get(name)!(parsed.data));
    } catch (error) {
      // The original SDK turns unexpected callback errors into tool errors.
      result = {content:[{type:"text",text:error instanceof Error ? error.message : String(error)}],isError:true};
    }
    return response(result, id, accept);
  } else return fallback();
  reportMcpDispatch("fast");
  return response(result, body.id, accept);
}

function response(result: unknown, id: string | number, accept: string): Response {
  const json = JSON.stringify({result,jsonrpc:"2.0",id});
  return new Response(accept.includes("text/event-stream") ? `event: message\ndata: ${json}\n\n` : json, {
    headers: { ...cors, "Cache-Control":"private, no-store, no-transform", Connection:"keep-alive", "Content-Type":accept.includes("text/event-stream")?"text/event-stream":"application/json", "X-Accel-Buffering":"no" },
  });
}
