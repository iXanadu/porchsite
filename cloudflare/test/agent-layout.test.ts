import {it,expect} from 'vitest';
import {THEMES} from '../src/themes.gen';
import {renderSample} from '../src/themecheck';
import {markdownDocument} from '../src/agent-markdown';
import sample0 from '../../themes/catalogue-page/sample.json';
import sample1 from '../../themes/event-page/sample.json';
import sample2 from '../../themes/group-page/sample.json';
import sample3 from '../../themes/link-page/sample.json';
import sample4 from '../../themes/listing-page/sample.json';
import sample5 from '../../themes/local-business/sample.json';
import sample6 from '../../themes/menu-page/sample.json';
import sample7 from '../../themes/personal-homepage/sample.json';
import sample8 from '../../themes/playbook/sample.json';
import sample9 from '../../themes/portfolio/sample.json';
import sample10 from '../../themes/product-page/sample.json';
import sample11 from '../../themes/services-page/sample.json';
const samples={'catalogue-page':sample0,'event-page':sample1,'group-page':sample2,'link-page':sample3,'listing-page':sample4,'local-business':sample5,'menu-page':sample6,'personal-homepage':sample7,'playbook':sample8,'portfolio':sample9,'product-page':sample10,'services-page':sample11};
// Independent source-boundary audit: prose formatting may intentionally split a word.
const INLINE=new Set('abbr b cite code dfn em i kbd q samp script strong style sub sup u var'.split(' '));
for(const [look,sample] of Object.entries(samples))it('af_markdown_visible_text all-look boundaries '+look,()=>{
 for(const [path,html] of Object.entries(renderSample(THEMES[look] as any,sample,'https://example.com',new Date('2026-10-15T15:30:00Z')))) {
  if(!path.endsWith('index.html'))continue;
  const markdown=markdownDocument(html,'https://example.com/'+path.slice(0,-10)).markdown;
  for(const match of html.matchAll(/([\p{L}\p{N}]+)<\/([a-z][\w:-]*)>\s*<([a-z][\w:-]*)\b[^>]*>([\p{L}\p{N}]+)/gu)) {
   if(INLINE.has(match[2])||INLINE.has(match[3]))continue;
   expect(markdown,`${look}/${path}: ${match[1]} | ${match[4]}`).not.toContain(match[1]+match[4]);
  }
 }
});
