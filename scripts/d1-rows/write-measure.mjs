import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {ORIGIN,COMPATIBILITY,hash} from './fixtures.mjs';
import {OPERATIONS,writeFixture,DAY,IP,UA} from './write-fixtures.mjs';
const q=(db,sql,...binds)=>db.prepare(sql).bind(...binds);
async function live(db){return(await db.prepare('SELECT item_id,kind,slug,version,data FROM live ORDER BY item_id').all()).results;}
async function outcome(db,operation,fixture,before,value,auth='valid') {
 const negative=auth!=='valid';
 assert(!value.counters.failed&&value.counters.closed,'operation counter scope failed');
 if(negative){assert.equal(value.status,auth==='badcsrf'?(operation==='import/file'?422:200):303,'wrong access-refusal status');assert.deepEqual(await live(db),before,'unauthorized owner operation changed publication');assert.equal(await db.prepare('SELECT count(*) n FROM approvals').first('n'),operation==='import/file'?0:1);assert.equal(await q(db,'SELECT count(*) n FROM items WHERE id NOT IN (SELECT item_id FROM live)').first('n'),operation==='import/file'?0:1);return;}
 if(operation.startsWith('collect/')) {
  assert.equal(value.status,204);assert.equal(value.bytes,0);assert.equal(value.credential_oracle_headers,false);assert.equal(Object.fromEntries(value.headers)['cache-control'],'no-store');
  if(operation==='collect/heartbeat') {
   const row=await q(db,'SELECT engaged_ms,max_scroll FROM pageviews WHERE id=?','existing_view_000').first();assert.deepEqual(row,{engaged_ms:1000,max_scroll:25});assert.equal(await db.prepare('SELECT count(*) n FROM pageviews').first('n'),1);
  } else {
   const expected=operation==='collect/at_cap'?0:1;
   assert.equal(await q(db,'SELECT count(*) n FROM pageviews WHERE id=?','view_attempt_201').first('n'),expected,'actual view disposition mismatch');
   assert.equal(await q(db,'SELECT count(*) n FROM pageviews WHERE day=?',DAY).first('n'),operation==='collect/at_cap'?200:operation==='collect/repeat'?2:1);
   assert.equal(await db.prepare('SELECT completed_day FROM analytics_maintenance WHERE id=1').first('completed_day'),DAY);
   if(operation==='collect/first_day') {
    assert.equal(await q(db,'SELECT count(*) n FROM pageviews WHERE day=?',fixture.first_expired_day).first('n'),0);
    assert.deepEqual(await q(db,'SELECT visits,views,engaged_ms FROM analytics_daily WHERE day=?',fixture.first_expired_day).first(),{visits:1,views:2,engaged_ms:0});
    assert.equal(await db.prepare('SELECT count(*) n FROM analytics_salts').first('n'),1);
    const salt=await q(db,'SELECT salt FROM analytics_salts WHERE day=?',DAY).first('salt');const visitor=await q(db,'SELECT visitor FROM pageviews WHERE id=?','view_attempt_201').first('visitor');assert.equal(visitor,hash(salt+IP+'\n'+UA).slice(0,32));
   }
  }
 } else if(operation.startsWith('approval/')) {
  assert.equal(value.status,200);const after=await live(db);assert.equal(after.length,before.length+fixture.ids.length);
  for(const ident of fixture.ids) {const row=after.find(x=>x.item_id===ident);assert(row);assert.equal(row.version,1);assert.equal(row.kind,'entry');const item=await q(db,'SELECT data FROM items WHERE id=?',ident).first();assert.deepEqual(JSON.parse(row.data),JSON.parse(item.data));}
  const approval=await q(db,'SELECT status,items FROM approvals WHERE id=?',fixture.approval).first();assert.equal(approval.status,'decided');assert(JSON.parse(approval.items).every(x=>x.status==='published'));
  assert.equal(await db.prepare('SELECT count(*) n FROM publishes').first('n'),1);
 } else {
  assert.equal(value.status,303);assert.match(Object.fromEntries(value.headers).location,/\/review\/[A-Za-z0-9_-]+$/);assert.deepEqual(await live(db),before);
  const approvals=(await db.prepare('SELECT items,status FROM approvals').all()).results;assert.equal(approvals.length,1);assert.equal(approvals[0].status,'pending');const items=JSON.parse(approvals[0].items);assert.equal(items.length,3);assert.deepEqual(items.map(x=>x.kind),['site','entry','card']);
  for(const item of items)assert(await q(db,'SELECT 1 FROM items WHERE id=?',item.id).first());
 }
}
export async function measureWrites({root,out,migrations,corpus,Miniflare,convertV4MiniflareOptions,applyMigration}) {
 fs.copyFileSync(path.join(root,'scripts/d1-rows/write-harness.mjs'),path.join(out,'write-harness.mjs'));
 const seed=corpus.find(x=>x.name==='services-page');assert(seed);const cells={};
 async function run(operation,mode,auth='valid') {
  const token=randomBytes(24).toString('base64url'),fixture=writeFixture(root,operation,token);
  const modules=['write-harness.mjs','clock.mjs','observer.mjs','application.js','application-measured.js','native-workers.mjs','wait-scope.mjs'].map(file=>({type:'ESModule',path:path.join(out,file)}));
  const mf=new Miniflare(convertV4MiniflareOptions({rootPath:out,modules,modulesRoot:out,...COMPATIBILITY,d1Databases:['DB'],kvNamespaces:['OAUTH_KV'],bindings:{SITE_URL:ORIGIN,PUBLIC_ARTIFACTS:mode==='on'?'1':'',PUBLIC_RESPONSES:'',ROW_OPERATION:operation,ROW_TOKEN:token,ROW_APPROVAL:fixture.approval,ROW_BODY:fixture.body,ROW_FILE:fixture.file,ROW_AUTH:auth},outboundService:()=>{throw Error('Write fixture attempted outbound request');}}));
  try {
   await mf.ready;const db=await mf.getD1Database('DB');
   for(const file of fs.readdirSync(migrations).filter(x=>x.endsWith('.sql')).sort())await applyMigration(db,fs.readFileSync(path.join(migrations,file),'utf8'));
   await db.exec(seed.sql);await db.exec(fixture.sql);const before=await live(db);
   const response=await mf.dispatchFetch(ORIGIN+'/');const value=await response.json();
   fs.writeFileSync(path.join(out,`attempt-${operation.replaceAll('/','-')}-${mode}-${auth}.json`),JSON.stringify({operation,mode,auth_control:auth,wrapper_status:response.status,status:value.status,stage:value.stage,counters:value.counters}));
   assert.equal(response.status,200,'write wrapper failed');
   await outcome(db,operation,fixture,before,value,auth);
   if(auth==='valid')cells[`operations/${mode}/${operation}`]={rows_read:value.counters.rows_read,rows_written:value.counters.rows_written};
   // Only credential-free numeric diagnostics persist.
   fs.writeFileSync(path.join(out,`write-${operation.replaceAll('/','-')}-${mode}-${auth}.json`),JSON.stringify({operation,mode,auth_control:auth,status:value.status,counters:value.counters}));
  }catch{throw Error(`Write operation refused: ${operation}/${mode}/${auth}`);}finally{await mf.dispose();}
 }
 for(const operation of OPERATIONS)for(const mode of ['off','on'])await run(operation,mode);
 for(const operation of ['approval/one','import/file'])for(const auth of ['absent','invalid','badcsrf'])await run(operation,'off',auth);
 return cells;
}
