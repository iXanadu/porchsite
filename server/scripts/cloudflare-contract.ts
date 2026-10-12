// What the server edition takes from the Cloudflare edition as data, so the
// two can't drift: the field guide (models.ts fieldGuide(), written from the
// zod schemas' descriptions) and the assistant tools as tools/list shows
// them (mcp.ts). Run by scripts/cloudflare-contract.sh.
import { writeFileSync } from "node:fs";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createServer } from "../../cloudflare/src/mcp";
import { fieldGuide, KIND_GUIDE } from "../../cloudflare/src/models";

const [guideOut, toolsOut] = process.argv.slice(2);
writeFileSync(guideOut, `${JSON.stringify({ kinds: KIND_GUIDE, fields: fieldGuide() }, null, 2)}\n`);

const server = createServer();
const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
await server.connect(transport);
const res = await transport.handleRequest(
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }),
);
const { result } = (await res.json()) as { result: { tools: unknown[] } };
writeFileSync(toolsOut, `${JSON.stringify({ instructions: (server as any).server._instructions ?? null, tools: result.tools }, null, 2)}\n`);
