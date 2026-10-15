/** Local/test observation only; no token, request data or public response field. */
export type McpDispatchPath = "fast" | "sdk";
let observer: ((path: McpDispatchPath) => void) | undefined;
export function observeMcpDispatch(value?: (path: McpDispatchPath) => void): void { observer = value; }
export function reportMcpDispatch(path: McpDispatchPath): void { observer?.(path); }
