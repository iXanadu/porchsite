import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
// Replay paired native HTTP captures with shipped CSS, without page requests.
// PYTHON=<project interpreter> CHROME_PATH=<browser> node scripts/agent-layout-browser.mjs CAPTURE_DIR
const require=createRequire(import.meta.url),{chromium}=require('playwright-core');
assert(process.argv[2], 'Supply the paired native HTTP capture directory');
const out=path.resolve(process.argv[2]),root=fileURLToPath(new URL('../..',import.meta.url));
const python=process.env.PYTHON??'python3';
const report={revision:process.env.AF_REVISION??execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),method:'Computed parent layout and child block-display boundaries in native visitor HTML; compare concatenated last/first words against native Markdown. Both widths and editions. No projection helper reused.',pages:0,boundaries:[],glued:[],knownCases:[],proseBoundariesChecked:0,proseChanged:[],proseFixtures:[]};
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
try{
 const context=await browser.newContext({javaScriptEnabled:false});await context.route('**/*',route=>route.fulfill({status:200,body:''}));const page=await context.newPage();
 for(const edition of ['server','cloudflare'])for(const file of (await fs.readdir(out+'/'+edition)).filter(x=>x.endsWith('.json'))){
  const rows=JSON.parse(await fs.readFile(out+'/'+edition+'/'+file,'utf8')),theme=file.slice(0,-5);const css=await fs.readFile(root+'/themes/'+theme+'/static/site.css','utf8');
  const rendered=JSON.parse(execFileSync(python,[root+'/server/scripts/agent-markdown-oracle.py'],{input:JSON.stringify(Object.fromEntries(rows.filter(x=>x.probe==='discovery').map(x=>[x.path,x.body]))),encoding:'utf8',maxBuffer:4*1024*1024}));
  for(const row of rows.filter(x=>!x.probe&&x.headers['content-type'].startsWith('text/html'))){
   const md=rows.find(x=>x.path===row.path+'index.md'&&x.probe==='discovery').body;const plain=md.replace(/\]\(<[^>]*>\)/g,']').replace(/\\([\\`*_{}\[\]()#+.!|~-])/g,'$1').replace(/[*_`\[\]]/g,'');
   // Use exact shipped styles, disable scripts and all fetching; image/font shape is irrelevant to flex/grid membership.
   const source=row.body.replace(/<link\b[^>]*>/gi,'').replace('</head>','<style>'+css+'</style></head>');
   await page.setContent(source,{waitUntil:'domcontentloaded'});report.pages++;
   for(const width of [390,1440]){
    await page.setViewportSize({width,height:900});
    const prose=await page.evaluate(markdownHTML=>{
     const source=document.querySelector('main')||document.body,copy=new DOMParser().parseFromString(markdownHTML,'text/html'),actual=copy.body.textContent;let checked=0;const changed=[];
     const visible=e=>e.getClientRects().length&&!e.closest('[hidden],[aria-hidden="true"],script,style,nav,form,button');
     function leaf(n,last){if(n.nodeType===1&&n.tagName==='BR')return '\n';if(n.nodeType===3)return n.textContent;if(n.nodeType!==1||!visible(n))return '';const list=[...n.childNodes];if(last)list.reverse();for(const c of list){const t=leaf(c,last);if(t)return t;}return '';}
     for(const parent of source.querySelectorAll('*')){
      if(!visible(parent)||!Array.from(parent.childNodes).some(n=>n.nodeType===3&&n.textContent.trim())||['flex','inline-flex','grid','inline-grid'].includes(getComputedStyle(parent).display))continue;
      const kids=Array.from(parent.childNodes).filter(n=>n.nodeType===3?n.textContent.length:n.nodeType===1&&visible(n)&&(n.textContent.length||n.tagName==='BR'));
      for(let i=1;i<kids.length;i++){
       const a=kids[i-1],b=kids[i];if([a,b].some(n=>n.nodeType===1&&!['inline','contents'].includes(getComputedStyle(n).display)))continue;
       const left=leaf(a,true).match(/([\p{L}\p{N}]+)$/u)?.[1],right=leaf(b,false).match(/^([\p{L}\p{N}]+)/u)?.[1];if(!left||!right)continue;checked++;
       if(!actual.includes(left+right))changed.push({tag:parent.tagName,class:parent.className,left,right,expected:left+right});
      }
     }return {checked,changed};
    },rendered[row.path+'index.md']);
    report.proseBoundariesChecked+=prose.checked;for(const item of prose.changed)report.proseChanged.push({edition,theme,path:row.path,width,...item});
    if(edition==='server'&&theme==='event-page'&&row.path==='/events/saturday-dinner/')await page.screenshot({path:out+'/event-schedule-'+width+'.png',fullPage:true});
    const pairs=await page.evaluate(()=>{
     const pairs=[],scope=document.querySelector('main')||document.body;
     function shown(e){const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&!e.closest('[hidden],[aria-hidden="true"],script,style,nav,form,button,svg');}
     for(const parent of scope.querySelectorAll('*')){
      if(!shown(parent))continue;const layout=['flex','inline-flex','grid','inline-grid'].includes(getComputedStyle(parent).display);
      const kids=[...parent.children].filter(e=>shown(e)&&e.textContent.trim());
      for(let i=1;i<kids.length;i++){
       const a=kids[i-1],b=kids[i];if(!layout&&![a,b].some(e=>['block','flow-root','list-item','table','flex','grid'].includes(getComputedStyle(e).display)))continue;let node=a.nextSibling,space=false;
       while(node&&node!==b){if(node.nodeType===3&&/\s/.test(node.textContent))space=true;node=node.nextSibling;}
       if(space)continue;
       const left=a.textContent.trim().match(/([\p{L}\p{N}]+)$/u)?.[1],right=b.textContent.trim().match(/^([\p{L}\p{N}]+)/u)?.[1];
       if(left&&right&&left.length+right.length>=4)pairs.push({left,right,parent:parent.tagName+'.'+parent.className,display:getComputedStyle(parent).display});
      }
     }return pairs;
    });
    for(const pair of pairs){const record={edition,theme,path:row.path,width,...pair};report.boundaries.push(record);if(plain.includes(pair.left+pair.right))report.glued.push(record);}
   }
   if(theme==='playbook'&&['/','/start/','/start/tags/guide/'].includes(row.path)){
    assert(!md.includes('guideChoose'));assert(md.includes('How to read this guide Choose the page'));report.knownCases.push({edition,theme,path:row.path,pass:true});
   }
   if(theme==='personal-homepage'&&row.path==='/'){assert(md.includes('86 strips')&&md.includes('14 days'));assert(!md.includes('86strips')&&!md.includes('14days'));report.knownCases.push({edition,theme,path:row.path,pass:true});}
  }
 }
 const fixtureCases=JSON.parse(await fs.readFile(root+'/spec/fixtures/agent-prose.json','utf8')),inputs=fixtureCases.map(c=>'<html><head><title>Fixture</title></head><body><main>'+c.html+'</main></body></html>');
 const env={...process.env,PYTHONPATH:root+'/server'};
 const serverFixtures=JSON.parse(execFileSync(python,['-c',"import sys,json;from server.app.agent_markdown import markdown_document;print(json.dumps([markdown_document(s,'https://example.com/')['markdown'] for s in json.load(sys.stdin)]))"],{input:JSON.stringify(inputs),encoding:'utf8',env}));
 const esbuild=require('esbuild');esbuild.buildSync({stdin:{contents:'import fs from "node:fs";import {markdownDocument} from '+JSON.stringify(root+'/cloudflare/src/agent-markdown.ts')+';console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,"utf8")).map(s=>markdownDocument(s,"https://example.com/").markdown)));',resolveDir:root+'/cloudflare'},bundle:true,platform:'node',format:'esm',outfile:out+'/prose-fixtures-cf.mjs'});
 const cfFixtures=JSON.parse(execFileSync('node',[out+'/prose-fixtures-cf.mjs'],{input:JSON.stringify(inputs),encoding:'utf8'}));
 for(const [edition,actual] of [['server',serverFixtures],['cloudflare',cfFixtures]]){
  const html=JSON.parse(execFileSync(python,[root+'/server/scripts/agent-markdown-oracle.py'],{input:JSON.stringify(Object.fromEntries(actual.map((v,i)=>[i,v]))),encoding:'utf8'}));
  for(let i=0;i<fixtureCases.length;i++){const text=await page.evaluate(s=>new DOMParser().parseFromString(s,'text/html').body.textContent.replace(/[ \t\r\n\f]+/g,' ').trim(),html[i]);report.proseFixtures.push({edition,index:i,expected:fixtureCases[i].expected,pass:text.includes(fixtureCases[i].expected)});}
 }
 assert(report.proseFixtures.every(x=>x.pass));
 assert.equal(report.pages,220);assert.equal(report.knownCases.length,8);assert.deepEqual(report.proseChanged,[]);assert.deepEqual(report.glued,[]);report.pass=true;
}catch(e){report.failure=String(e.stack);process.exitCode=1;}finally{await browser.close();await fs.writeFile(out+'/semantic.json',JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,pages:report.pages,boundaries:report.boundaries.length,glued:report.glued,proseBoundariesChecked:report.proseBoundariesChecked,proseChanged:report.proseChanged,proseFixtures:report.proseFixtures,failure:report.failure}));}
