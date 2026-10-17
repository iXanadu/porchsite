// Seed through current HTTP/MCP/owner APIs, restart the PREVIOUS real runtime
// on the SAME database, and check public routes plus a signed passkey login.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');
const [root, previous, bundle, release, onlyEdition] = process.argv.slice(2);
if (!release) throw Error('usage: rollback-data.mjs ROOT PREVIOUS_CHECKOUT PREVIOUS_BUNDLE RELEASE');
if (onlyEdition && !['cloudflare', 'server'].includes(onlyEdition)) throw Error('optional diagnostic edition must be cloudflare or server');
const python = process.env.PYTHON || 'python3';
const require = createRequire(path.join(root, 'cloudflare/package.json'));
const { build } = require('esbuild');
const temp = mkdtempSync(path.join(os.tmpdir(), 'porchsite-rollback-data-'));
const setupCode = 'local-rollback-setup-code';
const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
const adapter = path.join(root, 'scripts/upgrade/server-runtime.py');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const running = new Set(), databases = new Set();
async function cleanup() {
  for (const stop of [...running]) await stop();
  for (const name of [...databases]) {
    command(python, [adapter, 'drop', name]);
    databases.delete(name);
  }
  rmSync(temp, { recursive: true, force: true });
}
let interrupted = false;
for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(signal, async () => {
  if (interrupted) return;
  interrupted = true;
  try { await cleanup(); } finally { process.exit(status); }
});
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { env: environment, encoding: 'utf8', ...options });
  if (result.status !== 0) throw Error(`${path.basename(executable)} ${args[0]} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
async function launch(executable, args, env, base) {
  const process = spawn(executable, args, { env: { ...environment, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  process.stdout.on('data', value => { log += value; });
  process.stderr.on('data', value => { log += value; });
  const exited = new Promise(resolve => process.once('exit', resolve));
  async function stop() {
    if (process.exitCode === null && process.signalCode === null) {
      globalThis.process.kill(-process.pid, 'SIGTERM');
      await Promise.race([exited, pause(15000)]);
      if (process.exitCode === null && process.signalCode === null) {
        globalThis.process.kill(-process.pid, 'SIGKILL');
        await exited;
      }
    }
    running.delete(stop);
  }
  running.add(stop);
  for (let attempt = 0; attempt < 150; attempt++) {
    if (process.exitCode !== null || process.signalCode !== null) throw Error(`runtime exited\n${log.slice(-3000)}`);
    try {
      const response = await fetch(base + '/robots.txt', { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return { stop };
    } catch {}
    await pause(200);
  }
  await stop();
  throw Error(`runtime readiness failed\n${log.slice(-3000)}`);
}

await build({ entryPoints: [path.join(root, 'cloudflare/test/softkey.ts')], outfile: path.join(temp, 'softkey.mjs'), bundle: true, platform: 'node', format: 'esm' });
const { SoftKey } = await import(pathToFileURL(path.join(temp, 'softkey.mjs')));
const images = JSON.parse(readFileSync(path.join(root, 'spec/image-privacy-cases.json'), 'utf8'));

function client(base) {
  const jar = new Map();
  async function request(route, init = {}, authenticated = true) {
    const headers = new Headers(init.headers);
    if (authenticated && jar.size) headers.set('cookie', [...jar].map(([k,v]) => `${k}=${v}`).join('; '));
    const response = await fetch(base + route, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (authenticated) for (const cookie of response.headers.getSetCookie()) {
      const match = /^([^=;]+)=([^;]*)/.exec(cookie);
      if (match) { if (match[2]) jar.set(match[1], match[2]); else jar.delete(match[1]); }
    }
    return response;
  }
  const post = (route, body) => request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { request, post, jar };
}
async function seed(base) {
  const http = client(base), key = await SoftKey.make();
  let response = await http.post('/setup/options', { code: setupCode, name: 'Rollback owner' });
  assert.equal(response.status, 200, await response.clone().text());
  const options = (await response.json()).options;
  response = await http.post('/setup/verify', await key.create(options, base));
  assert.equal(response.status, 200, await response.clone().text());
  const access = await (await http.request('/__rollback/key')).json();
  let serial = 0;
  async function rpc(method, params) {
    const response = await http.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${access.token}`, 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++serial, method, params }) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert(!result.error, JSON.stringify(result.error));
    return result.result;
  }
  async function call(name, args) {
    const result = await rpc('tools/call', { name, arguments: args });
    assert(!result.isError, `${name}: ${JSON.stringify(result)}`);
    return JSON.parse(result.content[0].text);
  }
  const tools = (await rpc('tools/list', {})).tools.map(t => t.name);
  const initialState = await call('site_state', {});
  const defaults = initialState.site_defaults;
  const receiptFeature = Object.hasOwn(initialState, 'training_choice');
  const brokerFeature = Object.hasOwn(defaults, 'broker');
  const streamFeature = Object.hasOwn(defaults, 'archive');
  const trainingFeature = Object.hasOwn(defaults, 'ai_training_disabled');
  const streamSettings = streamFeature ? {streams:[{id:'journal',title:'Rollback journal',sort:'title'},...Array.from({length:8},(_,i)=>({id:`stream-${i+1}`,title:`Rollback stream ${i+1}`}))], sections:['stream-8','journal'],archive:{enabled:true,title:'Rollback archive'}} : {};
  const picture = await call('image_add', { data: images['gps.jpeg'] });
  const site = await call('item_create', { kind: 'site', data: { ...(trainingFeature ? {ai_training_disabled: true} : {}), title: 'Rollback fixture', ...(brokerFeature ? {broker: 'Rollback Brokerage'} : {}), theme: 'personal-homepage', embed_sources: ['https://www.youtube-nocookie.com'], sections: ['journal'], ...streamSettings, timezone: 'UTC' } });
  if (brokerFeature) assert.equal((await call('site_state', {ids:[site.id]})).items[0].data.broker, 'Rollback Brokerage');
  const entry = await call('item_create', { kind: 'entry', data: { title: 'Rollback entry', date: '2026-10-15', tags: ['rollback'], cover: picture.image, cover_alt: 'Synthetic fixture', body: 'Rollback content.\n\n!embed[Demo](https://youtu.be/M7lc1UVf-VE)' } });
  let ninth;
  if (streamFeature) ninth = await call('item_create',{kind:'entry',data:{stream:'stream-8',title:'Ninth stream report',date:'2026-10-16',summary:'Extension is live',body:'Ninth stream body'}});
  const approval = await call('approval_request', { ids: [site.id, entry.id, ...(ninth ? [ninth.id] : [])], note: 'Rollback fixture' });
  const review = await http.request(new URL(approval.review_url).pathname);
  const page = await review.text(), csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
  assert(csrf, 'owner review must have a CSRF token');
  response = await http.request(new URL(approval.review_url).pathname, { method: 'POST', body: new URLSearchParams({ csrf, all: 'approve' }) });
  assert([200,302,303].includes(response.status), await response.text());
  const full = await call('site_state', { ids: [entry.id] });
  const slug = full.items[0].slug;
  assert(slug, 'new entry slug');
  const paths = ['/', '/journal/', '/journal/tags/rollback/', `/journal/${slug}/`, '/journal/search.json', '/journal/feed.xml', '/static/site.css', '/static/a.js', '/robots.txt', picture.image];
  response = await http.request(`/journal/${slug}/`, {}, false);
  assert.equal(response.status, 200);
  assert((await response.text()).includes('<iframe'), 'new code must actually publish an engine embed');
  const mediaResponse = await http.request(picture.image, {}, false);
  const mediaTag = mediaResponse.headers.get("ETag");
  assert.match(mediaTag, /^W\/"sha256-[a-f0-9]{64}"$/);
  assert.equal(mediaResponse.headers.get("Cache-Control"), "no-cache, no-transform");
  const stored = new Uint8Array(await mediaResponse.arrayBuffer());
  for (const method of ["GET", "HEAD"]) {
    const validated = await http.request(picture.image, {method, headers:{"If-None-Match":mediaTag}}, false);
    assert.equal(validated.status,304,"current media revalidation");
    assert.equal((await validated.arrayBuffer()).byteLength,0);
  }
  assert(stored.length < Buffer.from(images['gps.jpeg'], 'base64').length, 'the stored picture must have stripped metadata');
  for (const event of [{ t: 'pv', id: 'rollback-view-0001', p: '/', k: 'home' }, { t: 'hb', id: 'rollback-view-0001', e: 30000, d: 25 }, { t: 'hb', id: 'rollback-view-0001', e: 90000, d: 100 }]) {
    const r = await http.request('/collect', { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (rollback reader)', 'content-type': 'text/plain' }, body: JSON.stringify(event) }, false);
    assert.equal(r.status, 204);
  }
  const statistics = await call('site_stats', { include_test: true });
  assert.equal(statistics.totals.views, 1, 'new analytics must write a view');
  assert(statistics.totals.engaged_ms > 0, 'new analytics must store cumulative engagement');
  assert.equal(statistics.pages[0].reached['100'], 100, 'new analytics must store the final scroll snapshot');
  let agentTraffic;
  if (statistics.agent_traffic) {
    for (const ua of ['OAI-SearchBot', 'GPTBot', 'ChatGPT-User']) {
      assert.equal((await http.request('/', {headers:{'User-Agent':ua}}, false)).status, 200);
    }
    agentTraffic = (await call('site_stats', {})).agent_traffic.daily.filter(r => r.kind !== 'other');
    assert.equal(new Set(agentTraffic.map(r => r.kind)).size, 3, 'new daily agent kinds are populated');
  }
  const guideHandshake = await call('site_state', {ids:[],guide:{}});
  const guideRevision = guideHandshake.guide?.revision;
  if(guideRevision){
    assert.equal(guideHandshake.guide.included,true);
    const compact=await call('site_state',{ids:[],guide:{known_revision:guideRevision}});
    assert.equal(compact.guide.included,false);assert(!Object.hasOwn(compact,'fields'));
  }
  // Keep a second, unapproved source version too: the old owner UI must be
  // able to read current drafts/history without parsing a new JSON field.
  await call('item_update', { id: site.id, version: site.version, data: { title: 'Pending published title', ...(trainingFeature ? {ai_training_disabled: receiptFeature} : {}), ...(brokerFeature ? {broker: 'Pending Brokerage'} : {}), embed_sources: ['https://www.youtube-nocookie.com', 'https://my.matterport.com'] } });
  const pending = await call('approval_request', { ids: [site.id], note: 'Pending source fixture' });
  let batch = false;
  if (tools.includes('photo_batch_link')) {
    const link = await call('photo_batch_link', { purpose: 'Rollback photos' });
    const pathname = new URL(link.url).pathname;
    const html = await (await http.request(pathname)).text();
    const csrf = /(?:name="csrf" value="|data-csrf=")([^"]+)/.exec(html)?.[1];
    assert(csrf, 'batch CSRF token');
    const form = new FormData(); form.set('photo', new Blob([Buffer.from(images['gps.jpeg'], 'base64')], { type: 'image/jpeg' }), 'fixture.jpg'); form.set('alt', 'Rollback fixture'); form.set('csrf', csrf);
    const uploaded = await http.request(pathname, { method: 'POST', headers: { 'X-CSRF': csrf, Origin: base, Referer: base + pathname }, body: form });
    assert([200,302,303].includes(uploaded.status), await uploaded.text());
    const status = await call('photo_batch_status', { id: link.id });
    assert.equal(status.images.length, 1, 'batch image must be committed');
    const completed = await http.request(pathname + '/complete', { method: 'POST', headers: { 'X-CSRF': csrf, Origin: base, Referer: base + pathname }, body: new URLSearchParams({ csrf }) });
    assert([200,302,303].includes(completed.status), await completed.text());
    assert.equal((await call('photo_batch_status', { id: link.id })).status, 'done');
    batch = true;
  }
  if(streamFeature){const archive=await http.request('/archive/',{},false);assert.equal(archive.status,200);assert((await archive.text()).includes('Ninth stream report'));}
  let agentReadKeys=null;
  const assistants=await http.request('/review/assistants'),assistantsHTML=await assistants.text();
  if(assistantsHTML.includes('name="read_only"')){
    const csrf=/name="csrf" value="([^"]+)"/.exec(assistantsHTML)[1];
    const form=fields=>http.request('/review/assistants',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...fields})});
    const activeHTML=await(await form({make_key:'1',key_name:'Published reader active',read_only:'1'})).text();
    const active=/prk_[A-Za-z0-9_-]{32}/.exec(activeHTML)?.[0];assert(active,'new owner-issued read key');
    const revokeHTML=await(await form({make_key:'1',key_name:'Published reader revoked',read_only:'1'})).text();
    const revoked=/prk_[A-Za-z0-9_-]{32}/.exec(revokeHTML)?.[0];assert(revoked);
    const readId=/<h2>Published reader revoked<\/h2>[\s\S]*?name="revoke_read_key" value="([^"]+)"/.exec(revokeHTML)?.[1];assert(readId);
    await form({revoke_read_key:readId});agentReadKeys={active,revoked};
  }
  return { key, agentReadKeys, entryId:entry.id, slug, token:access.token, guideRevision, receiptFeature, agentTraffic, streamFeature, pendingVersion:site.version+1, paths, picture: picture.image, imageBytes: stored, mediaTag, pending: new URL(pending.review_url).pathname, features: { broker: brokerFeature, expandedStreams:streamFeature, trainingChoice:trainingFeature, approvedEmbed: true, pendingEmbed: true, gpsStrippedPicture: true, cumulativeAnalytics: true, photoBatch: batch } };
}
async function checkPrevious(base, fixture, edition) {
  if(fixture.agentReadKeys){for(const token of Object.values(fixture.agentReadKeys))await rejectedReadKey(base,token);}

  const http = client(base);
  const failures = [];
  let previousMediaTag;
  for (const route of fixture.paths) {
    const response = await http.request(route, {}, false), bytes = new Uint8Array(await response.arrayBuffer()), body = new TextDecoder().decode(bytes);
    if (response.status !== 200) { failures.push(`${route}: HTTP ${response.status}`); continue; }
    if (route === fixture.picture) {assert.deepEqual(bytes, fixture.imageBytes, 'previous media bytes must equal the newly stored stripped picture');previousMediaTag=response.headers.get('ETag');}
    if (route === '/' || route === '/journal/' || route.includes('/tags/') || route === fixture.paths[3]) {
      assert(body.includes('<html') && body.includes('Rollback'), `${edition} previous ${route}: missing populated HTML`);
    }
    if (route.endsWith('/feed.xml')) assert(body.includes('<feed') && body.includes('Rollback entry'), 'previous feed must include the new entry');
    const header = response.headers.get('X-Porchsite-Release');
    if (header) assert.equal(header, release, 'must exercise the previous runtime');
  }
  for (const method of ["GET", "HEAD"]) {
    const image = await http.request(fixture.picture,{method,headers:{"If-None-Match":fixture.mediaTag}},false);
    const expected = previousMediaTag === fixture.mediaTag ? 304 : 200;
    assert.equal(image.status,expected,"previous media honors its own validator or serves the stored bytes");
    const body = new Uint8Array(await image.arrayBuffer());
    if (method === "GET" && expected === 200) assert.deepEqual(body,fixture.imageBytes); else assert.equal(body.length,0);
    const missing = await http.request("/media/00000000000000000000000000000000.jpg",{method,headers:{"If-None-Match":"*"}},false);
    assert.equal(missing.status,404,"previous media miss cannot become 304");
    assert.match(missing.headers.get("Cache-Control"),/no-store/);
  }
  if (fixture.agentTraffic) {
    for (const ua of ['OAI-SearchBot', 'GPTBot', 'ChatGPT-User']) {
      assert.equal((await http.request('/', {headers:{'User-Agent':ua}}, false)).status, 200);
    }
    fixture.previousAgentTraffic = (await existingCall(base, fixture.token, 'site_stats', {})).agent_traffic;
  }
  if(fixture.guideRevision){
    let old;
    try{old=await existingCall(base,fixture.token,'site_state',{ids:[],guide:{known_revision:fixture.guideRevision}});}
    catch{old=await existingCall(base,fixture.token,'site_state',{ids:[]});}
    const included=!old.guide || old.guide.included;
    if(old.guide)assert.equal(old.guide.included,old.guide.revision!==fixture.guideRevision);
    for(const key of ['states','kinds','fields','site_defaults'])assert.equal(Object.hasOwn(old,key),!!included,'previous guide fallback keeps full blocks unless it understands the matching token');
  }
  let response = await http.post('/login/options', {});
  assert.equal(response.status, 200, await response.clone().text());
  response = await http.post('/login/verify', await fixture.key.get((await response.json()).options, base));
  assert.equal(response.status, 200, await response.clone().text());
  response = await http.request('/review');
  assert.equal(response.status, 200, 'previous owner sign-in must work');
  response = await http.request(fixture.pending);
  assert.equal(response.status, 200, 'previous owner must be able to review the new pending item');
  assert.equal(failures.length, 0, `${edition} previous runtime failed after current feature writes: ${failures.join('; ')}`);
  console.log(`rollback-data: ${edition}: ${fixture.paths.length} public routes/feed HTTP200; owner passkey sign-in ok; ${JSON.stringify(fixture.features)}`);
}

async function rejectedReadKey(base,token){
 for(const [method,params] of [['initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}],['tools/list',{}],['tools/call',{name:'item_create',arguments:{kind:'note',data:{text:'Forbidden read-key draft',date:'2026-10-17'}}}]]){
  const r=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  assert.equal(r.status,401,'old or revoked read key must fail MCP auth');
 }
}
async function blankReadKey(base,token){
 for(const route of ['/','/index.md','/llms.txt','/missing/index.md','/review'])for(const method of ['GET','HEAD']){
  const r=await fetch(base+route,{method,headers:{Authorization:'Bearer '+token,'If-None-Match':'*',Accept:'text/markdown'},redirect:'manual'});
  assert.equal(r.status,404,'read key has no old private HTTP grant');assert.equal(await r.text(),method==='HEAD'?'':'<!doctype html><meta name="robots" content="noindex"><title></title>');assert(!r.headers.has('ETag'));
 }
}
async function checkTraining(base, fixture, disabled) {
  if (!fixture.receiptFeature) return;
  const state = await existingCall(base,fixture.token,'site_state',{ids:['site']});
  assert.equal(state.training_choice.effective_disabled,disabled,'only a receipted live version may disable training after runtime return');
  const page = await fetch(base+'/'), robots = await (await fetch(base+'/robots.txt')).text();
  assert.equal(page.headers.get('Content-Signal'),`search=yes, ai-input=yes, ai-train=${disabled?'no':'yes'}`);
  assert.equal(robots.includes('User-agent: GPTBot'),disabled);
  return state;
}

async function loginOwner(base,fixture){
 const http=client(base);let r=await http.post('/login/options',{});assert.equal(r.status,200);
 r=await http.post('/login/verify',await fixture.key.get((await r.json()).options,base));assert.equal(r.status,200);return http;
}
async function approveAt(http,path){
 let r=await http.request(path);assert.equal(r.status,200);const body=await r.text();
 const csrf=/name="csrf" value="([^"]+)"/.exec(body)?.[1];assert(csrf,'old owner review CSRF');
 r=await http.request(path,{method:'POST',body:new URLSearchParams({csrf,all:'approve'})});
 assert([200,302,303].includes(r.status),await r.text());
}
async function existingCall(base,token,name,args){
 const r=await fetch(base+'/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
 assert.equal(r.status,200);const rpc=await r.json();assert(!rpc.error,JSON.stringify(rpc));assert(!rpc.result.isError,JSON.stringify(rpc.result));return JSON.parse(rpc.result.content[0].text);
}

const failures = [];
try {
  for (const edition of onlyEdition ? [onlyEdition] : ['cloudflare', 'server']) {
    const port = await freePort(), base = `http://localhost:${port}`;
    let runtime, database;
    try {
      let current, old;
      if (edition === 'cloudflare') {
        const dir = path.join(temp, 'worker'); mkdirSync(dir);
        const entry = path.join(dir, 'current.ts');
        writeFileSync(entry, `import worker from ${JSON.stringify(path.join(root,'cloudflare/src/index.ts'))};\nimport * as keys from ${JSON.stringify(path.join(root,'cloudflare/src/keys.ts'))};\nimport * as recovery from ${JSON.stringify(path.join(root,'cloudflare/src/owner.ts'))};\nexport default {fetch(req,env,ctx){if(new URL(req.url).pathname==='/__rollback/recovery')return recovery.issueRecoveryCode(env.DB,'rollback-local-recovery-code-at-least-32-bytes').then(()=>Response.json({ok:true}));if(new URL(req.url).pathname==='/__rollback/key')return keys.create(env.DB,'Rollback fixture').then(Response.json);if(new URL(req.url).pathname==='/__rollback/artifacts')return env.DB.prepare('SELECT key,generation FROM public_artifacts').all().then(Response.json);return worker.fetch(req,env,ctx);}};\n`);
        copyFileSync(bundle, path.join(dir, 'previous.js'));
        const config = main => ({ name: 'rollback-fixture', main, compatibility_date: '2026-08-15', compatibility_flags: ['nodejs_compat'], d1_databases: [{ binding: 'DB', database_name: 'rollback-fixture', database_id: '00000000-0000-4000-8000-000000000000', migrations_dir: path.join(root,'cloudflare/migrations') }], kv_namespaces: [{ binding: 'OAUTH_KV', id: 'rollback-fixture' }], vars: { SETUP_CODE: setupCode, SITE_URL: base, PUBLIC_ARTIFACTS: '1' } });
        writeFileSync(path.join(dir,'current.json'),JSON.stringify({...config(entry),define:{RELEASE:JSON.stringify('rollback-current')}}));
        writeFileSync(path.join(dir,'previous.json'),JSON.stringify({...config(path.join(dir,'previous.js')),no_bundle:true}));
        const wrangler = path.join(root,'cloudflare/node_modules/.bin/wrangler'), state = path.join(temp,'d1');
        command(wrangler,['d1','migrations','apply','rollback-fixture','--local','--config',path.join(dir,'current.json'),'--persist-to',state]);
        const args = file => ['dev','--local','--config',path.join(dir,file),'--ip','127.0.0.1','--port',String(port),'--inspector-port','0','--persist-to',state,'--show-interactive-dev-session=false'];
        current = () => launch(wrangler,args('current.json'),{},base); old = () => launch(wrangler,args('previous.json'),{},base);
      } else {
        database = command(python,[adapter,'create']); databases.add(database);
        const url = new URL(process.env.PORCHSITE_TEST_DSN); url.pathname = '/' + database;
        const common = { PORCHSITE_DSN: url.href, PORCHSITE_SETUP_CODE: setupCode, PORCHSITE_SITE_URL: base, PORCHSITE_PUBLIC_ARTIFACTS: '1', ROLLBACK_PORT: String(port) };
        current = () => launch(python,[adapter,'serve-current'],{...common,PYTHONPATH:path.join(root,'server'),PORCHSITE_RELEASE:'rollback-current'},base);
        old = () => launch(python,[adapter,'serve-old'],{...common,PYTHONPATH:path.join(previous,'server'),PORCHSITE_RELEASE:release},base);
      }
      runtime = await current(); const fixture = await seed(base);
      await checkTraining(base,fixture,true);
      const artifactProbe=await fetch(base+'/__rollback/artifacts');
      fixture.artifactFeature=artifactProbe.status===200;
      if(fixture.artifactFeature){const rows=await artifactProbe.json();assert((rows.results??rows).length>0,'current code warmed stored anonymous copies');}
      console.log(`rollback-data: ${edition}: seeded current features ${JSON.stringify(fixture.features)}`);
      await runtime.stop(); runtime = null;
      runtime = await old(); await checkPrevious(base,fixture,edition);
      if(fixture.streamFeature){
        const previousState = await existingCall(base,fixture.token,'site_state',{});
        const previousDefaults = previousState.site_defaults;
        const previousReceipts = Object.hasOwn(previousState,'training_choice');
        const previousStreams = Object.hasOwn(previousDefaults,'archive');
        await runtime.stop(); runtime=null;
        runtime=await current();
        if (fixture.agentTraffic) {
          const returned = (await existingCall(base,fixture.token,'site_stats',{})).agent_traffic.daily.filter(r => r.kind !== 'other');
          if (!fixture.previousAgentTraffic) assert.deepEqual(returned, fixture.agentTraffic, 'old runtime ignores daily agent counters; returning to new preserves them');
          else for (const row of fixture.agentTraffic) assert(returned.some(r => r.day === row.day && r.kind === row.kind && r.requests >= row.requests), 'daily agent counters survive a counter-aware rollback');
          console.log(`rollback-data: ${edition}: daily agent aggregates survive actual previous runtime and return`);
        }
        if(fixture.guideRevision){
          const returned=await existingCall(base,fixture.token,'site_state',{ids:[],guide:{known_revision:fixture.guideRevision}});
          assert.deepEqual(returned.guide,{revision:fixture.guideRevision,included:false});assert(!Object.hasOwn(returned,'fields'));
          const stale=await existingCall(base,fixture.token,'site_state',{ids:[],guide:{known_revision:'rollback-older-guide'}});
          assert.equal(stale.guide.included,true);assert(Object.hasOwn(stale,'fields'));
          console.log(`rollback-data: ${edition}: actual previous full-guide fallback and return-to-new conditional guide PASS`);
        }
        let response=await fetch(base+'/archive/');assert.equal(response.status,200,'return to new code restores approved archive');
        assert((await response.text()).includes('Ninth stream report'),'approved ninth stream survives rollback');
        await checkTraining(base,fixture,true);
        await runtime.stop();runtime=null;
        runtime=await old();
        const beforeOldPublish=await fetch(base+'/');fixture.beforeOldPublishTag=beforeOldPublish.headers.get('ETag');
        const http=await loginOwner(base,fixture);
        await approveAt(http,fixture.pending);
        await runtime.stop();runtime=null;
        runtime=await current();
        if(fixture.artifactFeature){
          const previousRows=await(await fetch(base+'/__rollback/artifacts')).json();
          if(!existsSync(path.join(previous,'cloudflare/src/public-artifacts.ts')))assert((previousRows.results??previousRows).length>0,'artifact-unaware old runtime left prepared rows to validate on return');
          const fresh=await fetch(base+'/',{headers:{'If-None-Match':fixture.beforeOldPublishTag}});assert.equal(fresh.status,200,'old publication invalidates a warm prepared validator on return');
          const freshRows=await(await fetch(base+'/__rollback/artifacts')).json();assert.notDeepEqual(freshRows,previousRows,'complete dependency digest replaces rows after actual old publication');
        }
        response=await fetch(base+'/archive/');assert.equal(response.status,previousStreams ? 200 : 404,'only a stream-aware previous runtime may approve the extension');
        const unreceipted = await checkTraining(base,fixture,previousReceipts);
        if(fixture.receiptFeature && !previousReceipts){
          assert.equal(unreceipted.training_choice.proposed_disabled,true,'actual old approval leaves the unseen true field intact');
          assert.equal(unreceipted.training_choice.needs_publication,true);
          const owner=await loginOwner(base,fixture),review=await owner.request('/review');
          assert((await review.text()).includes('AI training is currently allowed. Training-off is proposed;'));
        }
        await runtime.stop();runtime=null;
        runtime=await old();
        const edited=await existingCall(base,fixture.token,'item_update',{id:'site',version:fixture.pendingVersion,data:{title:'Rollback old edit'}});
        assert.equal(edited.version,fixture.pendingVersion+1);
        const a=await existingCall(base,fixture.token,'approval_request',{ids:['site'],note:'Old edit must not inherit extension'});
        await approveAt(await loginOwner(base,fixture),new URL(a.review_url).pathname);
        await runtime.stop();runtime=null;
        runtime=await current();
        const state=await existingCall(base,fixture.token,'site_state',{ids:['site']});
        if(fixture.artifactFeature){const page=await(await fetch(base+'/')).text();assert(page.includes('Rollback old edit'),'actual previous edit cannot return the prior prepared title');console.log(`rollback-data: ${edition}: prepared copies survive rollback storage but stale published dependencies cannot be delivered on return`);}
        assert.equal(state.items[0].data.streams.length,previousStreams ? 9 : 8,'stream-aware previous edits preserve the extension; unaware edits only retain legacy streams');
        assert.equal(!!state.items[0].data.archive?.enabled,previousStreams,'unaware old edits cannot inherit archive');
        assert.equal((await fetch(base+'/archive/')).status,previousStreams ? 200 : 404);
        await checkTraining(base,fixture,previousReceipts);
        if(fixture.receiptFeature){
          const fresh=await existingCall(base,fixture.token,'item_update',{id:'site',version:edited.version,data:{ai_training_disabled:true}});
          const requested=await existingCall(base,fixture.token,'approval_request',{ids:['site'],note:'Show the training choice for current-code owner approval'});
          await approveAt(await loginOwner(base,fixture),new URL(requested.review_url).pathname);
          await checkTraining(base,fixture,true);
          console.log(`rollback-data: ${edition}: training receipt survives rollback; ${previousReceipts?'receipt-aware previous approval/edit preserves shown choice':'old approval/edit cannot activate unseen choice'}; fresh shown owner approval activates its own version ${fresh.version}`);
        }
        if(fixture.artifactFeature){
          const entryPath=`/journal/${fixture.slug}/`;
          const before=(await fetch(base+'/')).headers.get('ETag');
          await runtime.stop();runtime=null;runtime=await old();
          const owner=await loginOwner(base,fixture),review=await owner.request('/review'),reviewHTML=await review.text();
          const csrf=/id="share-cards" hidden data-csrf="([^"]+)"/.exec(reviewHTML)?.[1];assert(csrf,'actual old card upload CSRF');
          const jpeg=Uint8Array.from([255,216,255,192,0,17,8,2,118,4,176,...Array(64).fill(7)]);
          const uploaded=await owner.request(`/review/cards/${fixture.entryId}?version=1`,{method:'POST',headers:{'Content-Type':'image/jpeg','X-CSRF':csrf},body:jpeg});assert.equal(uploaded.status,204,'actual old share-card write');
          async function oldSite(data){
            const state=await existingCall(base,fixture.token,'site_state',{ids:['site']});
            await existingCall(base,fixture.token,'item_update',{id:'site',version:state.items[0].version,data});
            const approval=await existingCall(base,fixture.token,'approval_request',{ids:['site'],note:'Rollback prepared-copy mutation'});
            await approveAt(await loginOwner(base,fixture),new URL(approval.review_url).pathname);
          }
          await oldSite({theme:'local-business'});
          await runtime.stop();runtime=null;runtime=await current();
          const themed=await fetch(base+'/',{headers:{'If-None-Match':before}});assert.equal(themed.status,200,'actual old theme selection invalidates prepared HTML');
          const shared=await fetch(base+entryPath),sharedBody=await shared.text();assert.match(sharedBody,/<meta property="og:image" content="http:\/\/localhost:\d+\/media\/[a-f0-9]{32}\.jpg">/,'actual old share card appears after return');
          await fetch(base+'/index.md');await fetch(base+'/llms.txt');
          await runtime.stop();runtime=null;runtime=await old();await oldSite({private:true});
          if(fixture.agentReadKeys)for(const token of Object.values(fixture.agentReadKeys))await blankReadKey(base,token);
          await runtime.stop();runtime=null;runtime=await current();
          for(const path of ['/','/index.md','/llms.txt',entryPath+'index.md'])for(const method of ['GET','HEAD']){
            const denial=await fetch(base+path,{method,headers:{'If-None-Match':'*'}});assert.equal(denial.status,404);assert.equal(await denial.text(),method==='HEAD'?'':'<!doctype html><meta name="robots" content="noindex"><title></title>');
            for(const header of ['ETag','Last-Modified','Link','Vary','Content-Signal'])assert(!denial.headers.has(header),'private return has no '+header);
          }
          const empty=await(await fetch(base+'/__rollback/artifacts')).json();assert.equal((empty.results??empty).length,0,'actual old private-on clears prepared rows without serving them');
          await runtime.stop();runtime=null;runtime=await old();await oldSite({private:false});
          await runtime.stop();runtime=null;runtime=await current();
          const warm=await fetch(base+entryPath),oldTag=warm.headers.get('ETag');assert.equal(warm.status,200);await fetch(base+'/llms.txt');
          await runtime.stop();runtime=null;runtime=await old();
          await existingCall(base,fixture.token,'item_remove',{id:fixture.entryId,version:1});
          const removed=await existingCall(base,fixture.token,'approval_request',{ids:[fixture.entryId],note:'Actual old unpublish'});await approveAt(await loginOwner(base,fixture),new URL(removed.review_url).pathname);
          await runtime.stop();runtime=null;runtime=await current();
          const missing=await fetch(base+entryPath,{headers:{'If-None-Match':oldTag}});assert.equal(missing.status,404);assert(!missing.headers.has('ETag'));assert(!(await(await fetch(base+'/llms.txt')).text()).includes(base+entryPath+'index.md'));
          console.log(`rollback-data: ${edition}: actual old theme/share-card/private-on/public-return/unpublish invalidate prepared HTML/Markdown/map; no stale 304 or private artifact`);
        }
        console.log(`rollback-data: ${edition}: 9-stream return restored; ${previousStreams ? 'stream-aware previous approval/edit preserves settings' : 'old approval and old edit cannot activate extension'}`);
        if(fixture.agentReadKeys){
          const state=await existingCall(base,fixture.agentReadKeys.active,'site_state',{});assert.equal(state.scope,'published_read');
          await rejectedReadKey(base,fixture.agentReadKeys.revoked);
          const currentSite=await existingCall(base,fixture.token,'site_state',{ids:['site']});
          await existingCall(base,fixture.token,'item_update',{id:'site',version:currentSite.items[0].version,data:{private:true}});
          const pending=await existingCall(base,fixture.token,'approval_request',{ids:['site'],note:'Read-key recovery boundary'});await approveAt(await loginOwner(base,fixture),new URL(pending.review_url).pathname);
          const prepared=await fetch(base+'/__rollback/recovery');assert.equal(prepared.status,200);
          await runtime.stop();runtime=null;runtime=await old();
          const recovery=client(base),replacement=await SoftKey.make();
          const options=await recovery.post('/recover/options',{code:'rollback-local-recovery-code-at-least-32-bytes'});assert.equal(options.status,200);
          const restored=await recovery.post('/recover/verify',await replacement.create((await options.json()).options,base));assert.equal(restored.status,200,'actual previous runtime owner recovery');
          await runtime.stop();runtime=null;runtime=await current();
          for(const token of Object.values(fixture.agentReadKeys)){await rejectedReadKey(base,token);await blankReadKey(base,token);}
          console.log(`rollback-data: ${edition}: new read prefix rejected by actual old runtime; revoke survives return; actual old owner recovery invalidates read keys by epoch`);
        }

      }
    } catch (error) {
      failures.push(`${edition}: ${error.stack || error}`);
    } finally {
      if (runtime) await runtime.stop();
      if (database) { command(python,[adapter,'drop',database]); databases.delete(database); }
    }
  }
} finally { await cleanup(); }
if (failures.length) throw Error(failures.join('\n'));
