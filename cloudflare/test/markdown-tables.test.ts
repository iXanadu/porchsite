import {expect,it} from 'vitest';
import {markdown} from '../src/html';
import {markdownDocument} from '../src/agent-markdown';
it('md_pipe_table_bounds: columns, padded cells and recursive tables share one document budget',()=>{
 const source=(n:number)=>'| '+Array(n).fill('H').join(' | ')+' |\n| '+Array(n).fill('-').join(' | ')+' |';
 expect(markdown(source(64)).html.match(/<th /g)).toHaveLength(64);
 expect(markdown(source(65)).html).not.toContain('<table');
 const full=source(64)+'\n'+Array(64).fill('kept').join('\n');
 const rendered=markdown(full+'\n\n> '+source(2).replace(/\n/g,'\n> ')).html;
 expect(rendered.match(/<(?:th|td)\b/g)).toHaveLength(4096);
 expect(rendered).toContain('<p>kept</p>');
 expect(rendered.match(/<table /g)).toHaveLength(1);
 expect(rendered).toContain('<blockquote><p>');
});
it('md_pipe_tables: standalone blocks terminate once and never expand inside a cell',()=>{
 let calls=0;const block=(s:string)=>s==='!embed[demo]'?(calls++,'<aside>Embedded</aside>'):null;
 const result=markdown('A | B\n- | -\n!embed[demo]',block).html;
 expect(calls).toBe(1);expect(result).toMatch(/<\/table><\/div>\n<aside>Embedded<\/aside>$/);
 calls=0;expect(markdown('A | B\n- | -\nx | !embed[demo]',block).html).toContain('!embed[demo]');expect(calls).toBe(0);
});
it('af_pipe_table_roundtrip: code, backslashes, literal HTML, images and pipes retain visible data',()=>{
 const body=markdown('| Header | Value |\n| :-- | --: |\n| `a\\\\b` | <script> |\n| x\\|y | ![alt\\|text](/media/'+'a'.repeat(32)+'.png) |').html;
 const result=markdownDocument('<main><h1>Round trip</h1>'+body+'</main>','https://example.com/table/').markdown;
 expect(result).toContain('| :--- | ---: |');expect(result).toContain('` a\\\\b `');
 expect(result).toContain('x\\|y');expect(result).toContain('&lt;script&gt;');expect(result).toContain('![alt\\|text]');expect(result).not.toContain('<table');
});
