import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import paths from "../../spec/fixtures/oauth-preflight-paths.json";
const origin = "https://site.example";
const context = () => ({waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext);
it("oauth_preflight_framing: every path omits Content-Length without lookup or fetch", async () => {
  const noStorage = new Proxy({}, {get(){throw new Error("OAuth preflight touched storage");}});
  const e = {...env,DB:noStorage,OAUTH_KV:noStorage,SITE_URL:origin} as unknown as Env;
  const fetch = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("unexpected metadata fetch"));
  try {
    for(const path of paths) for(const caller of [null,origin,"https://other.example"]) {
      let baseline: Record<string,string> | undefined;
      for(const auth of [null,"Bearer psk_invalid","Bearer prk_invalid","Bearer owner:missing:token","Basic unused"]) {
        const headers = {...(caller ? {Origin:caller}:{}),...(auth ? {Authorization:auth}:{})};
        const response = await worker.fetch(new Request(origin+path,{method:"OPTIONS",headers}),e,context());
        expect(response.status,path).toBe(204);expect(await response.text()).toBe("");
        for(const name of ["Content-Length","WWW-Authenticate","Set-Cookie","ETag","Location"]) expect(response.headers.has(name),path+" "+name).toBe(false);
        const current = Object.fromEntries(response.headers);
        if(baseline) expect(current).toEqual(baseline);else baseline=current;
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {fetch.mockRestore();}
});
