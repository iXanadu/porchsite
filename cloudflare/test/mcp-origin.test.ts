import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { create } from "../src/keys";
import { originalMcp } from "../src/mcp-original";
import cases from "../../spec/fixtures/mcp-origins.json";
const e = env as unknown as Env;
const at = "https://site.example";
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {client:"Origin test",origin:at} } as unknown as ExecutionContext;
function request(url: string, token: string, origin: string | null, method = "POST") {
  return new Request(url, { method, headers: {
    Authorization: `Bearer ${token}`, "Content-Type":"application/json", Accept:"application/json",
    ...(origin === null ? {} : {Origin:origin}),
  }, ...(method === "POST" ? {body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})} : {}) });
}
for (const row of cases) it(`MCP Origin boundary: ${row.name}`, async () => {
  const { token } = await create(e.DB, "Origin test");
  const response = await worker.fetch(request(at+"/mcp", token, row.origin), e, ctx);
  expect(response.status, await response.clone().text()).toBe(row.status);
  if (row.status === 200) expect((await response.json() as any).result.tools.length).toBeGreaterThan(10);
  else expect((await response.json() as any).error.message).toMatch(/Invalid Origin/);
});
it("compares the configured origin, normalizes its www redirect and preserves auth", async () => {
  const { token } = await create(e.DB, "Origin test"), configured = {...e,SITE_URL:"https://www.canonical.example:8443/"};
  for (const [origin,status] of [["https://canonical.example:8443",200],["https://CANONICAL.EXAMPLE:8443",200],[at,403],["https://canonical.example",403]] as const) {
    expect((await worker.fetch(request(at+"/mcp",token,origin),configured,ctx)).status).toBe(status);
  }
  const redirected = await worker.fetch(request("https://www.site.example/mcp", token, at),e,ctx);
  expect(redirected.status).toBe(301);
  expect(redirected.headers.get("Location")).toBe(at+"/mcp");
  expect((await worker.fetch(request(redirected.headers.get("Location")!,token,at),e,ctx)).status).toBe(200);
  expect((await worker.fetch(request(at+"/mcp","psk_invalid",at),e,ctx)).status).toBe(401);
});
it("validates Origins before preflight/auth but retains the SDK Host defence", async () => {
  const { token } = await create(e.DB, "Origin test");
  for (const method of ["GET","HEAD","OPTIONS","POST"]) {
    expect((await worker.fetch(request(at+"/mcp",token,"https://other.example",method),e,ctx)).status).toBe(403);
  }
  expect((await worker.fetch(request(at+"/mcp",token,at,"OPTIONS"),e,ctx)).status).toBe((await worker.fetch(request(at+"/mcp",token,null,"OPTIONS"),e,ctx)).status);
  const req = request("https://example.workers.dev/mcp", token, "https://example.workers.dev");
  const headers = new Headers(req.headers);headers.set("Host","other.example");
  const denied = await originalMcp(new Request(req,{headers}),e,ctx);
  expect(denied.status).toBe(403);
});
it("does not apply the MCP Origin check to OAuth routes", async () => {
  for (const path of ["/authorize","/oauth/token","/oauth/register"]) {
    const method = path === "/authorize" ? "GET" : "POST";
    const make = (origin:string|null) => new Request(at+path,{method,headers:{"Content-Type":"application/json",...(origin===null?{}:{Origin:origin})},...(method==="POST"?{body:"{}"}:{})});
    const baseline = await worker.fetch(make(null),e,ctx);
    const foreign = await worker.fetch(make("https://other.example"),e,ctx);
    expect(foreign.status,path).toBe(baseline.status);
    expect(await foreign.text()).not.toContain("Invalid Origin");
  }
});

it("rejects duplicate Origin fields", async()=>{
 const {token}=await create(e.DB,"Origin test");
 const req=request(at+"/mcp",token,at), headers=new Headers(req.headers);
 headers.append("Origin","https://other.example");
 expect((await worker.fetch(new Request(req,{headers}),e,ctx)).status).toBe(403);
});
