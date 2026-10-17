import { it,expect } from 'vitest';
import { structuredData,structuredBlock } from '../src/structured-data';
import fixture from '../../spec/fixtures/agent-markdown.json';
for(const doc of fixture.documents)it('af_jsonld_visible_fields '+doc.name,()=>{
 expect(JSON.parse(structuredData(doc.html,doc.canonical))).toEqual({'@context':'https://schema.org','@type':doc.structuredType,url:doc.canonical,name:doc.title,...(doc.description?{description:doc.description}:{})});
});
it('af_injection_payload_matrix: JSON data cannot close the inert script or invent facts',()=>{
 const name='</script><script>globalThis.agentPayload=1</script>&\u2028\u2029';
 const html='<html><head><title>Owner</title><meta name="description" content="Hidden description"></head><body><main><h1>&lt;/script&gt;&lt;script&gt;globalThis.agentPayload=1&lt;/script&gt;&amp;\u2028\u2029</h1></main></body></html>';
 for(const path of ['/','/notes/','/notes/tags/example/','/notes/example/']) {
  const value=structuredData(html,'https://example.com'+path),obj=JSON.parse(value);
  expect(obj.name).toBe(name);expect(obj['@type']).toBe(path==='/notes/'||path.includes('/tags/')?'CollectionPage':'WebPage');
  expect(Object.keys(obj)).toEqual(['@context','@type','url','name']);expect(value).not.toMatch(/[<>&\u2028\u2029]/);
  expect(structuredBlock(html,'https://example.com'+path).match(/<\/script>/g)).toHaveLength(1);
 }
});
