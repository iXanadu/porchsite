// Replay native HTTP captures through Chromium with their delivered CSP intact.
// node scripts/structured-data-browser.mjs CAPTURE_ROOT (cloudflare/ and server/).
import { chromium } from 'playwright-core';
import { existsSync,readdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
const root=process.argv[2];
if(!root)throw Error('Pass the native HTTP capture directory');
const cache=join(homedir(),'Library/Caches/ms-playwright');
const candidates=existsSync(cache)?readdirSync(cache).filter(n=>n.startsWith('chromium-')).sort().reverse().map(n=>join(cache,n,'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')):[];
const executablePath=process.env.CHROME??[...candidates,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const browser=await chromium.launch({executablePath});
try {
 for(const edition of ['cloudflare','server']) {
  let pages=0,injections=0;
  const context=await browser.newContext();
  try {
   for(const name of readdirSync(join(root,edition)).filter(n=>n.endsWith('.json')).sort()) {
    const records=JSON.parse(readFileSync(join(root,edition,name),'utf8'));
    for(const record of records.filter(r=>!r.probe&&r.status===200&&r.headers['content-type']==='text/html; charset=utf-8')) {
     const page=await context.newPage();
     await page.route('**/*',route=>{
      if(route.request().isNavigationRequest()&&new URL(route.request().url()).pathname+new URL(route.request().url()).search===record.path) {
       const headers={...record.headers};delete headers['content-length'];
       return route.fulfill({status:record.status,headers,body:record.body});
      }
      return route.fulfill({status:404,body:''}); // no remote or provider fetches
     });
     await page.goto('https://site.example'+record.path,{waitUntil:'domcontentloaded'});
     const result=await page.evaluate(()=>{
      const blocks=[...document.querySelectorAll('script[type="application/ld+json"]')];
      const h1=document.querySelector('main h1')??document.querySelector('h1');
      const visibleName=(h1?h1.textContent:document.title).replace(/[ \t\r\n\f]+/g,' ').replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g,'');
      return {canonical:document.querySelector('link[rel="canonical"]')?.href,visibleName,count:blocks.length,text:blocks[0]?.textContent,value:blocks[0]?JSON.parse(blocks[0].textContent):null,payload:globalThis.agentPayload};
     });
     assert.equal(result.count,1,`${edition}/${name}${record.path}: one data block`);
     const canonical=new URL('https://site.example'+record.path);
     if(canonical.pathname==='/archive/'){const before=canonical.searchParams,ordered=new URLSearchParams();if(before.get('sort')&&before.get('sort')!=='date')ordered.set('sort',before.get('sort'));for(const key of ['stream','tag'])if(before.get(key))ordered.set(key,before.get(key));canonical.search=ordered.toString();}
     assert.equal(result.value.url,canonical.href);
     if(canonical.pathname==='/archive/')assert.equal(result.canonical,canonical.href);
     assert.equal(result.value['@context'],'https://schema.org');
     assert.equal(result.value.name,result.visibleName);
     assert.equal(result.payload,undefined);
     assert.ok(!/[<>&\u2028\u2029]/.test(result.text));
     assert.match(record.headers['content-security-policy'],/(?:^|;\s*)script-src 'self'(?:;|$)/);
     assert.ok(!record.headers['content-security-policy'].includes("script-src 'unsafe-inline'"));
     if(name==='injection.json'){assert.ok(result.value.name.includes('</script>'));injections++;}
     pages++;await page.close();
    }
   }
   assert.ok(pages>0);assert.ok(injections>0,'Native injection capture required');
   // The same delivered policy must block executable inline code.
   const probe=await context.newPage();
   const record=JSON.parse(readFileSync(join(root,edition,'injection.json'),'utf8'))[0];
   const probeHeaders={...record.headers};delete probeHeaders['content-length'];
   await probe.addInitScript(()=>{globalThis.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>globalThis.cspViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));});
   await probe.route('**/*',route=>route.fulfill({status:200,headers:probeHeaders,body:record.body.replace('</body>','<script>globalThis.agentPayload=1</script></body>')}));
   await probe.goto('https://site.example/',{waitUntil:'domcontentloaded'});
   await probe.waitForFunction(()=>globalThis.cspViolations.some(e=>e.directive==='script-src-elem'&&e.blocked==='inline'));
   assert.equal(await probe.evaluate(()=>globalThis.agentPayload),undefined);
   assert.ok((await probe.evaluate(()=>globalThis.cspViolations)).some(e=>e.directive==='script-src-elem'&&e.blocked==='inline'));
   await probe.close();
   console.log(`af_jsonld_visible_fields ${edition}: ${pages} native HTML pages, inert JSON parsed, injection contained, executable inline blocked; CSP unchanged`);
  } finally {await context.close();}
 }
} finally {await browser.close();}
