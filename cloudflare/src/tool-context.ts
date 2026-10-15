import { AsyncLocalStorage } from "node:async_hooks";
import { getMcpAuthContext } from "agents/mcp/server";

const context = new AsyncLocalStorage<Record<string, unknown>>();
export const withToolContext = <T>(props: Record<string, unknown>, fn: () => T): T => context.run(props, fn);
export const toolProps = () => context.getStore() ?? (getMcpAuthContext()?.props as Record<string, unknown> | undefined) ?? {};
