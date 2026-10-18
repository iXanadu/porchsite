import {createToolHandlers} from "../src/mcp";
import {withToolContext} from "../src/tool-context";
// Run only by vitest.parity.config.ts. Actual D1 + MCP handlers, fixed data.
import { env } from "cloudflare:workers";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { it, expect, vi } from "vitest";
import { validate } from "../src/content";
import { storedData } from "../src/embed-storage";
import { createServer } from "../src/mcp";
import { THEMES } from "../src/themes.gen";
import STATE_BASELINES from "../../spec/site-state-baselines.json";
import { GUIDE_REVISION } from "../src/site-guide";
import BASELINES from "../../spec/site-check-baselines.json";
import type { Env } from "../src/env";

type Case = { name: string; theme: string; sample: { site: Record<string, unknown>; items: { kind: string; slug?: string; data: Record<string, unknown> }[] }; home?: string };
const e = env as unknown as Env & { PARITY_CASES: string; PARITY_NOW: string; PARITY_OUTPUT: string };
const cases: Case[] = JSON.parse(e.PARITY_CASES);
const stamp = (n: number) => new Date(Date.UTC(2026, 9, 10, 12, 0, n)).toISOString();
function decoded(text:string):unknown {try{return JSON.parse(text);}catch{return text;}}
function ordered(value: any): any {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}

it("compares all sample tool answers with deterministic fixtures", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(e.PARITY_NOW));
  try {
    for (const c of cases) {
      await e.DB.batch(["items", "live", "themes", "site_embed_sources", "site_fields", "private_approvals"].map(table => e.DB.prepare(`DELETE FROM ${table}`)));
      let theme = c.theme;
      if (c.home !== undefined) {
        theme = `parity-${c.name}`;
        const base = THEMES[c.theme];
        const look = { ...base, manifest: { ...base.manifest, name: theme }, pages: { ...base.pages, home: c.home } };
        await e.DB.prepare("INSERT INTO themes (name, version, package, sha256, installed_at, installed_by, source) VALUES (?, '1.0.0', ?, 'fixture', ?, 'assistant:test', 'private')").bind(theme, JSON.stringify(look), stamp(0)).run();
      }
      const rows = [{ id: "site", kind: "site", slug: null as string | null, data: validate("site", { ...c.sample.site, theme }) },
        ...c.sample.items.map((item, i) => ({ id: `i${i}`, kind: item.kind, slug: item.kind === "entry" ? item.slug ?? `item-${i}` : null, data: validate(item.kind, item.data) }))];
      await e.DB.batch(rows.flatMap((row, i) => [
        e.DB.prepare("INSERT INTO items (id, kind, slug, version, data, deleted, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 0, ?, ?)").bind(row.id, row.kind, row.slug, JSON.stringify(storedData(row.kind,row.data)), stamp(i), stamp(i)),
        e.DB.prepare("INSERT INTO live (item_id, kind, slug, version, data, published_at) VALUES (?, ?, ?, 1, ?, ?)").bind(row.id, row.kind, row.slug, JSON.stringify(storedData(row.kind,row.data)), stamp(i)),
      ]));
      const logical = rows[0].data as Record<string,unknown>;
      await e.DB.prepare("INSERT INTO site_embed_sources (version,sources,approved) VALUES (1,?,1)").bind(JSON.stringify(logical.embed_sources ?? [])).run();
      if (logical.broker) await e.DB.prepare("INSERT INTO site_fields (version,key,value,approved) VALUES (1,'broker',?,1)").bind(JSON.stringify(logical.broker)).run();
      if (logical.private) await e.DB.batch([e.DB.prepare("INSERT INTO site_fields (version,key,value,approved) VALUES (1,'private','true',1)"),e.DB.prepare("INSERT INTO private_approvals (version) VALUES (1)")]);
      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      const answers: Record<string, unknown> = {};
      try {
        const calls: [string, string, Record<string, unknown>][] = [
          ["site_check", "site_check", {}], ["site_check_deep", "site_check", {deep:true}], ["site_state", "site_state", {}],
          ["site_state_full", "site_state", { full: true }],
          ["site_state_ids", "site_state", { ids: ["site", "i0"] }],
          ["site_state_empty", "site_state", { ids: [] }],
          ["site_state_unknown", "site_state", { ids: ["missing"] }],
          ["site_state_guide_first", "site_state", {guide:{}}],
          ["site_state_guide_match", "site_state", {guide:{known_revision:GUIDE_REVISION}}],
          ["site_state_guide_stale", "site_state", {ids:["site","i0"],guide:{known_revision:"old-guide"}}],
          ["site_state_guide_empty", "site_state", {ids:[],guide:{known_revision:GUIDE_REVISION}}],
          ["site_state_guide_unknown", "site_state", {ids:["missing"],guide:{known_revision:GUIDE_REVISION}}],
          ["site_state_guide_invalid_null", "site_state", {guide:null}],
          ["site_state_guide_invalid_member", "site_state", {guide:{unknown:true}}],
          ["site_state_guide_invalid_token", "site_state", {guide:{known_revision:"token\n"}}],
          ["site_state_guide_invalid_long", "site_state", {guide:{known_revision:"x".repeat(129)}}],
        ];
        for (const [key, name, args] of calls) {
          const response = await transport.handleRequest(new Request("https://example.invalid/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
          expect(response.status).toBe(200);
          const rpc = await response.json() as any;
          if ((key === "site_check" || key === "site_check_deep") && c.name in BASELINES.cases) {
            const expected = BASELINES.cases[c.name as keyof typeof BASELINES.cases];
            expect(rpc.result.content[0].text, `${c.name} ${key} historical bytes`).toBe(key === "site_check" ? expected.quick : expected.deep);
          }
          const historical=(STATE_BASELINES.cases as Record<string,Record<string,Record<string,string>>>)[c.name]?.cloudflare?.[key];
          if(key.startsWith("site_state")&&!key.startsWith("site_state_guide")){
            expect(historical, `${c.name} ${key} must have a pre-change byte baseline`).toBeTruthy();
            const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(rpc.result.content[0].text)));
            expect([...digest].map(n=>n.toString(16).padStart(2,"0")).join(""),`${c.name} ${key} unchanged bytes`).toBe(historical);
          }
          if(key === "site_state_guide_match"){
            const baseline=(answers.site_state as any).value,expected={...baseline};
            for(const k of ["states","kinds","fields","site_defaults"])delete expected[k];
            expected.guide={revision:GUIDE_REVISION,included:false};
            expect(JSON.parse(rpc.result.content[0].text)).toEqual(expected);
            console.info("GUIDE_SAMPLE_BYTES "+JSON.stringify({name:c.name,full:new TextEncoder().encode(JSON.stringify(baseline)).length,compact:new TextEncoder().encode(rpc.result.content[0].text).length}));
          }
          answers[key] = { error: !!rpc.result.isError, value: decoded(rpc.result.content[0].text) };
        }
        await e.DB.prepare('DELETE FROM agent_read_keys').run();
        await e.DB.prepare("INSERT INTO agent_read_keys(id,name,key_hash,created_at,expires_at,owner_epoch) SELECT 'read_parity','Reader','fixture','2026-10-10T12:00:00.000Z','2099-01-01T00:00:00.000Z',owner_epoch FROM auth_state WHERE id=1").run();
        const epoch=await e.DB.prepare('SELECT owner_epoch FROM auth_state WHERE id=1').first<number>('owner_epoch');
        const props={scope:'published_read',readKeyId:'read_parity',ownerEpoch:epoch,origin:'https://example.invalid'};
        for(const [key,name,args] of [['ag_state','site_state',{}],['ag_state_guide','site_state',{guide:{}}],['ag_state_full','site_state',{full:true}],['ag_check','site_check',{}],['ag_check_deep','site_check',{deep:true}],['ag_pages','pages_list',{}],['ag_pages_one','pages_list',{limit:1}],['ag_pages_tag','pages_list',{tag:'missing'}],['ag_search','search',{query:'site'}],['ag_search_unicode','search',{query:'ΟΣ İ CAFE\u0301'}],['ag_page_home','page_get',{path:'/'}],['ag_page_missing','page_get',{path:'/not-published/'}]] as [string,string,any][]){
          const result=await withToolContext(props,()=>createToolHandlers().get(name)!(args));
          answers[key]={error:!!result.isError,value:decoded(result.content[0].text)};
        }
        const first=(answers.ag_pages_one as any).value;
        if(first.next_cursor){const result=await withToolContext(props,()=>createToolHandlers().get('pages_list')!({limit:1,cursor:first.next_cursor}));answers.ag_pages_next={error:!!result.isError,value:decoded(result.content[0].text)};}
      } finally { await server.close(); }
      // Vitest's snapshot bridge writes to the host, outside the Worker. These
      // are fresh temporary files, never committed snapshots or expectations.
      await expect(JSON.stringify(ordered(answers), null, 2) + "\n").toMatchFileSnapshot(`${e.PARITY_OUTPUT}/${c.name}.json`);
    }
  } finally { vi.useRealTimers(); }
});
