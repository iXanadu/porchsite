// MD-1: compare source rendering and visitor-copy projection on shared cases.
import {readFileSync} from 'node:fs';
import {markdown} from '../src/html';
import {markdownDocument} from '../src/agent-markdown';
const cases=JSON.parse(readFileSync(process.argv[2]+'/spec/markdown-cases.json','utf8')) as {name:string;markdown:string}[];
const output=cases.map(c=>{const html=markdown(c.markdown).html;return {name:c.name,html,markdown:markdownDocument('<main><h1>Sample</h1>'+html+'</main>','https://example.com/page/').markdown};});
console.log(JSON.stringify(output));
