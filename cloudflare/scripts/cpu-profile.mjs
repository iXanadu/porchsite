#!/usr/bin/env node
// Local-only HTTP CPU profiles. Never deploy the generated fixture wrapper.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const harnessSha256=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const lock = '/tmp/porchsite-suite.lock';
const startingLoad = loadavg()[0];
if (startingLoad >= 8) throw new Error(`Wait for one-minute load below 8 (now ${startingLoad}).`);
if (options['lock-held'] !== 'true') {
  mkdirSync(lock);
  process.on('exit', () => rmdirSync(lock));
} else if (!existsSync(lock)) throw new Error('--lock-held requires an existing coordinator-owned suite lock');
const repo = resolve(options.build ?? join(dirname(fileURLToPath(import.meta.url)), '../..'));
const cf = join(repo, 'cloudflare');
const output = resolve(options.output ?? mkdtempSync(join(tmpdir(), 'site-cpu-')));
mkdirSync(output, { recursive: true });
const previousResults=existsSync(join(output,'results.json'))?JSON.parse(readFileSync(join(output,'results.json'))):[];
if (previousResults.length && options.resume!=='true') throw new Error('Choose a fresh output directory or explicitly --resume true.');
const work = mkdtempSync(join(output, 'runtime-'));
const port = Number(options.port ?? 8801), inspector = Number(options.inspector ?? 9241);
const origin = `http://127.0.0.1:${port}`;
const wrangler = join(cf, 'node_modules/wrangler/bin/wrangler.js');
const { default: InspectorWebSocket } = await import(join(cf, 'node_modules/ws/wrapper.mjs'));
const run = (args) => {
  const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: cf, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } });
  if (result.status !== 0) throw new Error(`wrangler ${args[0]} failed: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
const sourceDiff = spawnSync('git', ['diff', 'HEAD', '--', 'cloudflare/src', 'cloudflare/package.json', 'cloudflare/package-lock.json', 'themes'], { cwd: repo, encoding: 'utf8', maxBuffer:16*1024*1024 }).stdout;
const sourceState = { dirty:!!sourceDiff, diffSha256:createHash('sha256').update(sourceDiff).digest('hex') };
const release = options.release ?? `${spawnSync('git',['show','-s','--format=%cd','--date=format-local:%Y.%m.%d','HEAD'],{cwd:repo,encoding:'utf8',env:{...process.env,TZ:'UTC'}}).stdout.trim()}-${revision.slice(0,7)}`;
const minify = options.minify !== 'false';
if(previousResults.length) {
 const previousMethod=JSON.parse(readFileSync(join(output,'method.json')));
 if(previousMethod.revision!==revision||previousMethod.diffSha256!==sourceState.diffSha256||previousMethod.release!==release||previousMethod.minify!==minify||previousMethod.harnessSha256!==harnessSha256) throw new Error('Resume requires the identical build, release, minification and harness.');
}
const selected = options.looks?.split(',') ?? readdirSync(join(repo, 'themes')).filter(n => existsSync(join(repo, 'themes', n, 'sample.json'))).sort();
const wanted = options.cases?.split(',');
const repeats = Number(options.repeats ?? 3);
const requestsPerProfile=Number(options['requests-per-profile']??1);
const warmupRequests=Number(options['warmup-requests']??1);
if(!Number.isInteger(warmupRequests)||warmupRequests<1||warmupRequests>1000)throw new Error('warmup-requests must be an integer from1 to1000');
if(!Number.isInteger(requestsPerProfile)||requestsPerProfile<1||requestsPerProfile>100)throw new Error('requests-per-profile must be an integer from1 to100');
const modes = options.modes?.split(',') ?? ['cold', 'warm'];
if (!Number.isInteger(repeats) || repeats < 1 || modes.some(m=>!['cold','warm'].includes(m))) throw new Error('Invalid repeats or modes');
if(requestsPerProfile>1&&modes.some(mode=>mode!=='warm'))throw new Error('Grouped profiles require warm mode');
const matrix={looks:selected,cases:wanted??null,repeats,modes,requestsPerProfile,warmupRequests};
if(previousResults.length&&JSON.stringify(JSON.parse(readFileSync(join(output,'method.json'))).matrix)!==JSON.stringify(matrix)) throw new Error('Resume requires the identical requested matrix');
writeFileSync(join(output,'method.json'),JSON.stringify({revision,...sourceState,harnessSha256,release,minify,matrix,startingLoad,node:process.version,cold:'First HTTP request after Wrangler inspector readiness; fresh process per measured cold request; eager startup before attachment excluded',warm:`${warmupRequests} unmeasured same-case requests, then measured requests; storage reset before each profile`,requestsPerProfile,warmupRequests,samplingIntervalUs:100,active:'sum timeDeltas except (idle), includes (program) and GC',outbound:'deterministic local fixtures; no network upstream measurements',authentication:'assistant-key bearer for MCP; hashed owner-session cookie for review',build:repo},null,2));
const token = `psk_${randomBytes(24).toString('base64url')}`, session = randomBytes(32).toString('base64url');
const hash = s => createHash('sha256').update(s).digest('hex');
const sql = v => v === null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`;
const stamp = '2026-10-10T12:00:00.000Z';
const until = '2099-01-01T00:00:00.000Z';
const passkeyToken='p'.repeat(32), uploadToken='u'.repeat(32);
let oauthClientId;
// Use this build's real validator for offline fixture defaults and aliases.
const esbuild = await import(join(cf, 'node_modules/esbuild/lib/main.js'));
esbuild.buildSync({ stdin: { contents: 'export { validate } from "./src/content.ts"; export { PREFIX } from "./src/models.ts";', resolveDir: cf }, bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'models.mjs') });
const { validate, PREFIX } = await import(join(work, 'models.mjs'));
esbuild.buildSync({ entryPoints: [join(cf, 'src/themes.gen.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'themes.mjs') });
const { THEMES } = await import(join(work, 'themes.mjs'));
const privateLook = { ...THEMES['product-page'], manifest: { ...THEMES['product-page'].manifest, name: 'fixture-private' }, sample:JSON.parse(readFileSync(join(repo,'themes/product-page/sample.json'))) };
const smallPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
const paddedPng = (size, variant=0) => { const b=Buffer.alloc(size);smallPng.copy(b);b[b.length-1]=variant;return b.toString('base64'); };
const largeImage = paddedPng(8*1024*1024), batchImages = Array.from({length:8},(_,i)=>paddedPng(1024*1024,i));
const sizeImages=[0.5,1,2,4].map(mib=>({mib,data:paddedPng(mib*1024*1024)}));
const hasDeepCheck = /deep: z\.boolean/.test(readFileSync(join(cf,'src/mcp.ts'),'utf8'));
const hasBatch = /images: z\.array/.test(readFileSync(join(cf,'src/mcp.ts'),'utf8'));
const hasStateSelection = /ids: z\.array/.test(readFileSync(join(cf,'src/mcp.ts'),'utf8')) && /full: z\.boolean/.test(readFileSync(join(cf,'src/mcp.ts'),'utf8'));

// The full product Worker remains the request handler. Outbound requests are
// answered by deterministic local fixtures, so write tools cannot contact a
// real catalog/queue. No fixture route is present in the product bundle.
const wrapper = join(work, 'worker.ts');
writeFileSync(wrapper, `import worker from ${JSON.stringify(join(cf, 'src/index.ts'))};
import { THEMES } from ${JSON.stringify(join(cf, 'src/themes.gen.ts'))};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
 if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, init);
 const look = THEMES['personal-homepage'];
 const text = JSON.stringify(look);
 if (url.pathname === '/themes.json') {
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  return Response.json({themes:[{name:look.manifest.name,version:look.manifest.version,package:{url:'https://example.invalid/package.json',sha256:digest}}]});
 }
 if (url.pathname === '/package.json') return new Response(text);
 if (url.pathname === '/latest.json') return Response.json({version:'2026.10.14-fbdd784',releases:[]});
 if (url.pathname.endsWith('/status')) return Response.json({requests:[],submissions:[]});
 if (url.pathname === '/requests' || url.pathname === '/submissions') return Response.json({id:'local-fixture',status:'open'});
 throw new Error('CPU fixture refused outbound request: '+url.origin+url.pathname);
};
export default worker;
`);
const config = join(work, 'wrangler.json');
const settings={ name: 'local-cpu-profile', main: wrapper, minify, upload_source_maps:true,define:{__RELEASE__:JSON.stringify(release)},compatibility_date: '2026-08-15', compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'], d1_databases: [{ binding: 'DB', database_name: 'local-cpu-profile', database_id: '00000000-0000-0000-0000-000000000001', migrations_dir: join(cf, 'migrations') }], kv_namespaces: [{ binding: 'OAUTH_KV', id: 'local-fixture' }] };
writeFileSync(config, JSON.stringify(settings));
// Preserve the exact bundle and source map used for CPU attribution. Dev's
// temporary output disappears on shutdown, so compile once with dry-run only.
const bundleDir=join(work,'bundle');
writeFileSync(join(output,'build.log'),run(['deploy','--dry-run','--config',config,'--outdir',bundleDir,'--metafile',join(bundleDir,'meta.json')]));
writeFileSync(config, JSON.stringify({...settings,main:join(bundleDir,'worker.js'),no_bundle:true}));
const state = join(work, 'state');
run(['d1', 'migrations', 'apply', 'local-cpu-profile', '--local', '--config', config, '--persist-to', state]);
// Model the ordinary cached update check consistently across samples. Its
// uncached external fetch is replaced by a fixture, not a hosted measurement.
run(['kv','key','put','porchsite:update-check',JSON.stringify({checked_at:Date.now(),latest:release,releases:[]}), '--binding','OAUTH_KV','--local','--config',config,'--persist-to',state]);
function findSqlite(path) {
  for (const n of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, n.name);
    if (n.isDirectory()) { const found = findSqlite(p); if (found) return found; }
    else if (p.endsWith('.sqlite')) return p;
  }
}
const db = new DatabaseSync(findSqlite(join(state, 'v3/d1')));
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all().map(r => r.name);
let processHandle, stoppingPromise;
async function stop() {
  if(stoppingPromise) return stoppingPromise;
  if (!processHandle) return;
  const child = processHandle; processHandle = undefined;
  stoppingPromise=(async()=>{
    const running=()=>child.exitCode===null&&child.signalCode===null;
    const exited=running()?new Promise(resolve=>child.once('exit',resolve)):Promise.resolve();
    if(running()) child.kill('SIGINT');
    await Promise.race([exited,delay(3000)]);
    if(running()) {child.kill('SIGKILL');await exited;}
    await delay(100);
  })();
  try {await stoppingPromise;} finally {stoppingPromise=undefined;}
}
process.on('SIGTERM', async () => { await stop(); process.exit(143); });
process.on('SIGINT', async () => { await stop(); process.exit(130); });
let pauseRequested=false;
process.on('SIGUSR2',()=>{pauseRequested=true;});
async function start() {
  // Refuse an occupied port before spawning: an unrelated inspector must never
  // turn into a falsely attributed cold profile for this build.
  for (const candidate of [port,inspector]) await new Promise((resolve,reject)=>{
    const server=createNetServer();
    server.once('error',error=>reject(new Error(`Local port ${candidate} is unavailable: ${error.message}`)));
    server.listen(candidate,'127.0.0.1',()=>server.close(resolve));
  });
  const log = [];
  const child = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', config, '--persist-to', state, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector)], { cwd: cf, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  processHandle=child;
  child.stdout.on('data', b => log.push(String(b)));
  child.stderr.on('data', b => log.push(String(b)));
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(log.join(''));
    if(!log.join('').includes(`Ready on ${origin}`)) {await delay(100);continue;}
    try {
      const targets = await (await fetch(`http://127.0.0.1:${inspector}/json/list`)).json();
      if (targets.some(t => t.webSocketDebuggerUrl)) { await delay(100); return; }
    } catch {}
    await delay(100);
  }
  throw new Error('Wrangler not ready: '+log.join(''));
}
async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${inspector}/json/list`)).json();
  const ws = new InspectorWebSocket(targets.find(t => t.webSocketDebuggerUrl).webSocketDebuggerUrl, { headers: { Origin: `http://localhost:${inspector}` } });
  await new Promise((resolve, reject) => {
    const timer=setTimeout(()=>{ws.terminate();reject(new Error('Inspector connection timed out'));},5000);
    ws.once('open',()=>{clearTimeout(timer);resolve();});
    ws.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => { const m = JSON.parse(event.data); if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  ws.on('close',()=>{for(const p of pending.values())p.reject(new Error('Inspector disconnected'));pending.clear();});
  return { call(method, params = {}) { return new Promise((resolve, reject) => {
    const requestId=++id;
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`Inspector ${method} timed out`));},20000);
    pending.set(requestId, { resolve:v=>{clearTimeout(timer);resolve(v);}, reject:e=>{clearTimeout(timer);reject(e);} });
    ws.send(JSON.stringify({ id:requestId, method, params }));
  }); }, close() { ws.close(); } };
}
function seed(look,c={}) {
  const sample = JSON.parse(readFileSync(join(repo, 'themes', look, 'sample.json')));
  const rows = [{ id: 'site', kind: 'site', slug: null, data: validate('site',{...sample.site,theme:look}) }, ...sample.items.map((item, i) => ({ id: `${PREFIX[item.kind]}_${i.toString(16).padStart(8, '0')}`, kind: item.kind, slug: item.kind === 'entry' ? item.slug ?? `item-${i}` : null, data: validate(item.kind,item.data) }))];
  if(rows[0].data.theme!==look) throw new Error('Fixture renderer does not match selected look');
  let commands = tables.map(t => `DELETE FROM "${t}";`).join('\n');
  for (const row of rows) {
    const data = JSON.stringify(row.data);
    const values = [row.id,row.kind,row.slug,1,data,0,stamp,stamp].map(sql).join(',');
    commands += `INSERT INTO items VALUES (${values});\n`;
    commands += `INSERT INTO live VALUES (${[row.id,row.kind,row.slug,1,data,stamp].map(sql).join(',')});\n`;
    commands += `INSERT INTO revisions VALUES (${[row.id,1,'create',data,0,'owner','fixture',stamp].map(sql).join(',')});\n`;
  }
  commands += `INSERT INTO assistant_keys(id,name,key_hash,created_at,expires_at) VALUES ('key_fixture','Local fixture',${sql(hash(token))},${sql(stamp)},${sql(until)});\n`;
  commands += `INSERT INTO owner VALUES (1,'Owner','fixture',${sql(stamp)});\nINSERT INTO sessions VALUES (${[createHash('sha256').update(session).digest('base64url'),stamp,until].map(sql).join(',')});\n`;
  const changed = { ...rows[0].data, tagline: 'A staged fixture change' };
  commands += `UPDATE items SET version=2,data=${sql(JSON.stringify(changed))} WHERE id='site';\n`;
  commands += `INSERT INTO revisions VALUES (${['site',2,'update',JSON.stringify(changed),0,'owner','fixture',stamp].map(sql).join(',')});\n`;
  const approval = [{id:'site',version:2,kind:'site',label:changed.title,change:'changed',status:'pending',note:''}];
  commands += `INSERT INTO approvals VALUES (${['fixture_approval',JSON.stringify(approval),'Fixture review','owner','pending','',stamp,null].map(sql).join(',')});\n`;
  commands += `INSERT INTO publishes(id,actor,approval_id,items,created_at) VALUES (1,'owner',NULL,${sql(JSON.stringify(rows.map(r=>({id:r.id,version:1}))))},${sql(stamp)});\n`;
  commands += `INSERT INTO uploads(id,token_hash,purpose,requested_by,created_at,expires_at) VALUES ('fixture_upload',${sql(hash(uploadToken))},'Local fixture','owner',${sql(stamp)},${sql(until)});\n`;
  commands += `INSERT INTO passkey_links(token_hash,created_at,expires_at) VALUES (${sql(createHash('sha256').update(passkeyToken).digest('base64url'))},${sql(stamp)},${sql(until)});\n`;
  commands += `INSERT INTO themes(name,version,package,sha256,installed_at,installed_by,source) VALUES ('fixture-private',${sql(privateLook.manifest.version)},${sql(JSON.stringify(privateLook))},'fixture',${sql(stamp)},'owner','private');\n`;
  if(c.ownerless) commands+='DELETE FROM owner;\n';
  if(c.linkState==='used') commands+=`UPDATE uploads SET media='/media/fixture.png',used_at=${sql(stamp)}; UPDATE passkey_links SET used_at=${sql(stamp)};\n`;
  if(c.linkState==='expired') commands+=`UPDATE uploads SET expires_at=${sql(stamp)}; UPDATE passkey_links SET expires_at=${sql(stamp)};\n`;
  if(c.name==='public:media') {
    const name=hash(smallPng).slice(0,32)+'.png';
    commands+=`INSERT INTO media(name,type,size,chunks,source,created_at,width,height) VALUES (${sql(name)},'image/png',${smallPng.length},1,'fixture',${sql(stamp)},1,1);\n`;
    commands+=`INSERT INTO media_chunks(name,n,data) VALUES (${sql(name)},0,X'${smallPng.toString('hex')}');\n`;
    commands+=`INSERT INTO share_cards(item_id,version,name,created_at) VALUES (${sql(rows.find(r=>r.kind==='entry').id)},1,${sql(name)},${sql(stamp)});\n`;
  }
  db.exec('BEGIN IMMEDIATE;'+commands+'COMMIT;');
  const actualTheme=db.prepare("SELECT json_extract(data,'$.theme') AS theme FROM live WHERE item_id='site'").get().theme;
  if(actualTheme!==look) throw new Error(`Published renderer ${actualTheme} does not match ${look}`);
  return { sample, rows };
}
function casesFor({ sample, rows }) {
  const entry = rows.find(r => r.kind === 'entry');
  const stream = sample.site.streams?.find(s => s.id === entry.data.stream) ?? { id: 'journal', path: 'journal' };
  const path = `/${stream.path || stream.id}/${entry.slug}/`;
  const get = (name, path, status = 200) => ({ name, path, status });
  const tool = (name, args = {}, variant = '') => ({ name: `tool:${name}${variant}`, tool: name, args, status: 200 });
  const png = smallPng.toString('base64');
  return [get('public:home','/'),get('public:entry',path,entry.data.external_url?302:200),get('public:archive',`/${stream.path||stream.id}/`),get('public:tag',`/${stream.path||stream.id}/tags/${entry.data.tags?.[0]??'fixture'}/`),get('public:not_found','/missing-fixture/',404),get('public:feed',`/${stream.path||stream.id}/feed.xml`),get('public:search',`/${stream.path||stream.id}/search.json`),get('public:css','/static/site.css'),get('public:beacon','/static/a.js'),get('public:robots','/robots.txt'),get('public:sitemap','/sitemap.xml'),
    get('public:login','/login'),{...get('public:setup','/setup?code=fixture'),ownerless:true},get('public:setup:claimed','/setup',303),
    get('public:passkey',`/passkey/${passkeyToken}`),{...get('public:passkey:used',`/passkey/${passkeyToken}`,410),linkState:'used'},{...get('public:passkey:expired',`/passkey/${passkeyToken}`,410),linkState:'expired'},
    get('public:upload',`/upload/${uploadToken}`),{...get('public:upload:used',`/upload/${uploadToken}`,410),linkState:'used'},{...get('public:upload:expired',`/upload/${uploadToken}`,410),linkState:'expired'},
    {...get('public:authorize',()=>'/authorize?'+new URLSearchParams({client_id:oauthClientId,redirect_uri:'https://client.example/callback',response_type:'code',scope:'site:draft',code_challenge:'A'.repeat(43),code_challenge_method:'S256',state:'fixture'})),owner:true},get('public:media',`/media/${hash(smallPng).slice(0,32)}.png`),
    ...['','/import','/cards.json','/passkeys','/assistants','/stats','/history','/history/1','/write','/write/new',`/write/${entry.id}`,`/write/${entry.id}/preview`,'/fixture_approval','/fixture_approval/preview/',`/fixture_approval/preview${path}`,`/fixture_approval/preview/${stream.path||stream.id}/`,`/fixture_approval/preview/${stream.path||stream.id}/tags/${entry.data.tags?.[0]??'fixture'}/`].map(p=>get(`review:${p||'index'}`,`/review${p}`, p===`/fixture_approval/preview${path}`&&entry.data.external_url?302:200)),
    { name:'mcp:initialize',method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'local-cpu-fixture',version:'1.0'}},status:200 },{ name:'mcp:tools/list', method:'tools/list',status:200 },
    tool('site_state'),...(hasStateSelection?[tool('site_state',{full:true},':full'),tool('site_state',{ids:['site']},':ids')]:[]),tool('approval_status'),tool('site_check'),...(hasDeepCheck?[tool('site_check',{deep:true},':deep')]:[]),tool('site_stats'),tool('theme_list'),tool('theme_needs'),
    tool('item_create',{kind:'note',data:{text:'Fixture note',date:'2026-10-10'}}),tool('item_update',{id:'site',version:2,data:{tagline:'Profile fixture'}}),tool('item_remove',{id:entry.id,version:1}),tool('item_history',{id:entry.id}),tool('item_rollback',{id:'site',to_version:1,version:2}),tool('photo_upload_link'),tool('image_add',{data:png}),...sizeImages.map(({mib,data})=>tool('image_add',{data},`:${mib}MiB`)),tool('image_add',{data:largeImage},':8MiB'),...(hasBatch?[tool('image_add',{images:batchImages},':batch8MiB')]:[]),tool('approval_request',{ids:['site']}),
    // Status and theme creation/submission/install need per-case preparation.
    tool('photo_upload_status',{id:'fixture_upload'}),tool('theme_request',{type:'business',title:'Local fixture',description:'A local profiling fixture'}),tool('theme_install',{name:'personal-homepage'}),
    tool('theme_create', {manifest:privateLook.manifest,sample:JSON.parse(readFileSync(join(repo,'themes/product-page/sample.json'))),pages:privateLook.pages,partials:privateLook.partials,css:privateLook.static['site.css']}),tool('theme_submit',{name:'fixture-private',note:'A local profiling fixture'})];
}
async function request(c) {
  const headers = { ...(c.name.startsWith('review:')||c.owner?{cookie:`__Host-sk_owner=${session}`} : {}), 'user-agent':'LocalCPUFixture/1.0' };
  let init = { headers, redirect:'manual' };
  if (c.tool || c.method) {
    init = { ...init, method:'POST',headers:{...headers,authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:c.method??'tools/call',...(c.tool?{params:{name:c.tool,arguments:c.args}}:c.params?{params:c.params}:{})}) };
  }
  const start = performance.now();
  const r = await fetch(origin+(typeof c.path==='function'?c.path():c.path??'/mcp'),{...init,signal:AbortSignal.timeout(60000)});
  const responseBytes=Buffer.from(await r.arrayBuffer());
  const body = responseBytes.toString('utf8');
  const wallMs = performance.now()-start;
  if (r.status !== c.status) throw new Error(`${c.name}: HTTP${r.status}, expected${c.status}: ${body.slice(0,400)}`);
  if(c.name==='public:media'&&!r.headers.get('cache-control')?.startsWith('public,')) throw new Error('Media fixture did not exercise published visitor serving');
  if(c.name==='public:media'&&!responseBytes.equals(smallPng)) throw new Error('Published media bytes differ from fixture');
  let toolError = false, toolNames;
  if (c.tool||c.method) { const rpc=JSON.parse(body); if(rpc.error) throw new Error(JSON.stringify(rpc.error)); toolError=!!rpc.result?.isError; if(toolError||!rpc.result) throw new Error(`${c.name}: ${body.slice(0,1200)}`); }
  if(c.method==='tools/list') toolNames=JSON.parse(body).result.tools.map(t=>t.name);
  return { status:r.status,bytes:responseBytes.length,wallMs,toolError,...(toolNames?{toolNames}:{}) };
}
function summarize(profile) {
  const nodes = new Map(profile.nodes.map(n=>[n.id,n]));
  let active=0,idle=0;
  const functions = {};
  for(let i=0;i<(profile.samples??[]).length;i++) {
    const node=nodes.get(profile.samples[i]); const name=node.callFrame.functionName||'(anonymous)';const us=profile.timeDeltas[i];
    if(name==='(idle)') idle+=us; else {active+=us;functions[name]=(functions[name]??0)+us;}
  }
  return { sampledActiveMs:active/1000,sampledIdleMs:idle/1000,sampleCount:profile.samples?.length??0,windowMs:(profile.endTime-profile.startTime)/1000,functionsUs:functions };
}
const results=[...previousResults];
const completed=(look,c,mode,n)=>results.some(r=>r.look===look&&r.case===c.name&&r.mode===mode&&r.iteration===n);
try {
  // Client registration is fixture setup in a separate, discarded isolate.
  // Each measured cold request still gets a new process afterward.
  if(!wanted||wanted.includes('public:authorize')) {
    seed(selected[0]);await start();
    const response=await fetch(origin+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Local fixture',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']})});
    const registration=await response.json();
    if(!response.ok||!registration.client_id) throw new Error('Local OAuth fixture registration failed');
    oauthClientId=registration.client_id;
    await stop();
  }
  measurements: for(const look of selected) {
    const fixture=seed(look);
    const selectedCases=casesFor(fixture).filter(c=>!wanted||wanted.some(w=>c.name===w||c.tool===w));
    if(!selectedCases.length) throw new Error(`No matching cases for ${look}`);
    for(const c of selectedCases) {
      if((requestsPerProfile>1||warmupRequests>1)&&(c.tool||c.method||!c.name.startsWith('public:')))throw new Error('Grouped profiles support read-only public GETs only');
      for(const mode of modes) {
        if(pauseRequested) break measurements;
        if(Array.from({length:repeats},(_,n)=>completed(look,c,mode,n)).every(Boolean)) continue;
        await stop(); seed(look,c); await start();
        if(mode==='warm') for(let warmup=0;warmup<warmupRequests;warmup++)await request(c);
        for(let n=0;n<repeats;n++) {
          if(pauseRequested) break measurements;
          if(completed(look,c,mode,n)) continue;
          if(mode==='cold'&&n) {await stop();seed(look,c);await start();}
          else seed(look,c);
          const debuggerSession=await connect();
          try {
            await debuggerSession.call('Profiler.enable');
            await debuggerSession.call('Profiler.setSamplingInterval',{interval:100});
            await debuggerSession.call('Profiler.start');
            let response,responseBytesTotal=0;
            for(let call=0;call<requestsPerProfile;call++){response=await request(c);responseBytesTotal+=response.bytes;}
            const {profile}=await debuggerSession.call('Profiler.stop');
            const basename=`${look}-${c.name.replaceAll(/[^\w.-]/g,'_')}-${mode}-${n}`;
            writeFileSync(join(output,basename+'.cpuprofile'),JSON.stringify(profile));
            const totals=summarize(profile);
            const result={revision,...sourceState,look,renderer:look,case:c.name,mode,iteration:n,...response,...totals,requestsPerProfile,responseBytesTotal,sampledActivePerRequestMs:totals.sampledActiveMs/requestsPerProfile};
            results.push(result); console.log(JSON.stringify({...result,functionsUs:undefined}));
            writeFileSync(join(output,'results.json'),JSON.stringify(results,null,2));
          } finally {debuggerSession.close();}
        }
      }
    }
  }
} finally { await stop(); db.close(); }
if(!wanted&&!pauseRequested) for(const look of selected) {
 const discovered=results.find(r=>r.look===look&&r.case==='mcp:tools/list')?.toolNames;
 if(!discovered?.length) throw new Error('No tools discovered');
 const absent=discovered.filter(name=>!results.some(r=>r.look===look&&r.case===`tool:${name}`));
 if(absent.length) throw new Error('Tool coverage missing: '+absent.join(','));
}
const report=['| Build | Sample | Request | Cold active sampled ms per request min/median/max | Warm active sampled ms per request min/median/max |','|---|---|---|---|---|'];
for(const key of new Set(results.map(r=>`${r.look}\t${r.case}`))) {
 const [look,name]=key.split('\t');
 const cell=mode=>{const a=results.filter(r=>r.look===look&&r.case===name&&r.mode===mode).map(r=>r.sampledActivePerRequestMs??r.sampledActiveMs).sort((a,b)=>a-b);return a.length?`${a[0].toFixed(3)} / ${a[Math.floor(a.length/2)].toFixed(3)} / ${a.at(-1).toFixed(3)}`:'—';};
 report.push(`| ${revision.slice(0,7)}${sourceState.dirty?'+dirty':''} | ${look} | ${name} | ${cell('cold')} | ${cell('warm')} |`);
}
writeFileSync(join(output,'table.md'),report.join('\n')+'\n');
console.log(`${pauseRequested?'PAUSED (incomplete)':'COMPLETE'}: profiles and table: ${output}`);
if(pauseRequested) process.exitCode=75;
