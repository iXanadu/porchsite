import MarkdownIt from 'markdown-it';
import {expect,it} from 'vitest';
import {markdownDocument} from '../src/agent-markdown';
import cases from '../../spec/fixtures/markdown-escaping.json';
import intraword from '../../spec/fixtures/markdown-intraword.json';
for(const c of intraword)it('af_markdown_intraword_underscore '+c.name,()=>{
 const actual=markdownDocument(c.html,c.canonical).markdown;
 expect(actual).toBe(c.markdown);
 for(const gfm of [false,true]){
  const parser=new MarkdownIt('commonmark',{html:true});
  if(gfm)parser.enable(['table','strikethrough']);
  // The legacy escaped image alt loses its underscore in the parser.
  expect(parser.render(actual)).toBe(c.rendered??parser.render(c.legacy));
 }
});
for(const c of cases)it('af_markdown_minimal_escaping '+c.name,()=>{
 expect(markdownDocument(c.html,c.canonical).markdown).toBe(c.markdown);
 const parser=new MarkdownIt('commonmark',{html:true}).enable(['table','strikethrough']);
 const text=(t:any):string=>t.children?t.children.map(text).join(''):['text','code_inline','image','fence','code_block'].includes(t.type)?t.content:['softbreak','hardbreak'].includes(t.type)?' ':'';
 expect(parser.parse(c.content,{}).map(text).join(' ').replace(/\s+/g,' ').trim()).toBe(c.visible);
 if(c.name.startsWith('joined_'))expect(parser.render(c.content)).not.toMatch(/<(?:ol|s|hr)\b/);
});
