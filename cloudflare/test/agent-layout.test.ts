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
import fixtures from '../../spec/fixtures/agent-markdown.json';
// These edges were found by the independent offline CSS/computed-display audit.
for(const [look,sample] of Object.entries(samples))it('af_markdown_visible_text all-look boundaries '+look,()=>{
 const pages=renderSample(THEMES[look] as any,sample,'https://example.com',new Date('2026-10-15T15:30:00Z'));
 for(const [theme,path,left,right] of fixtures.layoutBoundaries.filter(row=>row[0]===look)) {
  const html=pages[path.slice(1)+'index.html'];expect(html,`${theme}${path}`).toBeDefined();
  const markdown=markdownDocument(html,'https://example.com'+path).markdown;
  const plain=markdown.replace(/\]\(<[^>]*>\)/g,']').replace(/\\([\\`*_{}\[\]()#+.!|~-])/g,'$1').replace(/[*_`\[\]]/g,'');
  expect(plain,`${theme}${path}: ${left} | ${right}`).not.toContain(left+right);
 }
});
