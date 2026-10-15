import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as keys from "../src/keys";
import * as themes from "../src/themes";

it("keeps the default check free of look loading and validates deep", async () => {
  const e=env as unknown as Env;
  const {token}=await keys.create(e.DB,"Fixture");
  const ctx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
  const invoke=async(args:unknown)=>{
    const response=await worker.fetch(new Request("https://site.example/mcp",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"site_check",arguments:args}})}),e,ctx);
    expect(response.status).toBe(200);
    return (await response.json() as any).result;
  };
  const deep=await invoke({deep:true});
  expect(JSON.parse(deep.content[0].text)).toHaveProperty("unreachable",[]);
  const load=vi.spyOn(themes,"load").mockRejectedValue(new Error("quick must not load a look"));
  try {
    for(const args of [{},{deep:false},{unknown:true}]) {
      const result=await invoke(args);
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ok:true,broken:[],empty_sections:["Updates (journal)","cards","notes","about"]});
    }
    expect(load).not.toHaveBeenCalled();
    for(const deep of [null,"true",1,[],{}]) {
      const result=await invoke({deep});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("deep: Invalid input: expected boolean");
    }
  } finally {load.mockRestore();}
});
