import {expect,it} from 'vitest';
import {markdownDocument} from '../src/agent-markdown';
import cases from '../../spec/fixtures/markdown-escaping.json';
for(const c of cases)it('af_markdown_minimal_escaping '+c.name,()=>{
 expect(markdownDocument(c.html,c.canonical).markdown).toBe(c.markdown);
});
