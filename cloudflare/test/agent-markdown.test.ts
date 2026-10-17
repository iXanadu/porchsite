import { describe,it,expect } from 'vitest';
import { markdownDocument } from '../src/agent-markdown';
import { representation } from '../src/public-http';
import fixture from '../../spec/fixtures/agent-markdown.json';
describe('AF mechanical data boundary shared fixtures',()=>{
 for(const doc of fixture.documents)it('af_markdown_frozen_template '+doc.name,()=>{
  expect(markdownDocument(doc.html,doc.canonical)).toEqual({title:doc.title,description:doc.description,markdown:doc.markdown});
 });
 for(const [accept,selected] of fixture.accept)it('af_accept_negotiation '+accept,()=>expect(representation(accept as string|null)).toBe(selected));
});

import { agentPage } from '../src/agent-pages';
it('af_map_links_resolve: bounded complete Unicode lines, real visitor pages only',async()=>{
 for(const title of ['Visible title','🐦'.repeat(120)]) {
  const paths=Array.from({length:80},(_,i)=>`/notes/page-${i}/`);
  const route=async(req:Request)=>new Response(`<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>Owner text</p></main></body></html>`,{status:new URL(req.url).pathname==='/notes/page-1/'?404:200,headers:{'Content-Type':'text/html; charset=utf-8'}});
  const response=await agentPage(new Request('https://example.com/llms.txt'),route,async()=>paths,route),body=await response.text();
  expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(16384);
  const links=[...body.matchAll(/^- \[.*\]\(<(https:\/\/example.com\/[^>]*index\.md)>\)/gm)].map(m=>m[1]);
  expect(links.length).toBeGreaterThan(1);expect(links.length).toBeLessThanOrEqual(50);expect(body).not.toContain('/notes/page-1/index.md');
  for(const link of links)expect((await route(new Request(link.slice(0,-8)))).status).toBe(200);
  expect(body.endsWith('\n')).toBe(true);expect(body).not.toContain('�');
 }
});
