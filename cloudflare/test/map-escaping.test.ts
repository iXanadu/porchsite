import {it,expect} from 'vitest';
import {mapResponse} from '../src/agent-map';
import cases from '../../spec/fixtures/map-escaping.json';
it.each(cases)('ll2_map_escaping: $name',async(c)=>{
 const response=mapResponse([{path:'/',title:c.title,description:c.description}],'https://site.example');
 const expected=`# ${c.escaped_title}\n\n${c.escaped_description}\n\n- [${c.escaped_title}](<https://site.example/index.md>): ${c.escaped_description}\n`;
 expect(await response.text()).toBe(expected);expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
});
