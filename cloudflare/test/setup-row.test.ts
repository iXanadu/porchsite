import {env} from 'cloudflare:workers';
import {beforeEach,expect,it} from 'vitest';
import type {Env} from '../src/env';
import * as owner from '../src/owner';
import {SoftKey} from './softkey';
const db=(env as unknown as Env).DB;
const origin='https://site.example';
beforeEach(async()=>{for(const t of ['passkeys','sessions','owner','setup_codes','challenges'])await db.prepare(`DELETE FROM ${t}`).run();});
async function begin(code:string,secret?:string){
 const key=await SoftKey.make(),r=await owner.setupOptions(db,new Request(origin+'/setup/options'),secret,code,'Owner');
 return {response:await key.create(r.options,origin),req:new Request(origin+'/setup/verify',{headers:{Cookie:r.setCookieHeader.split(';')[0]}})};
}
function beforeBatch(action:()=>Promise<unknown>):D1Database{
 return new Proxy(db,{get(target,key){if(key==='batch')return async(stmts:D1PreparedStatement[])=>{await action();return target.batch(stmts);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
}
it('stores canonical UTF-8 SHA256, trims only submitted surrounding whitespace and consumes the row on success',async()=>{
 await owner.issueSetupCode(db,'setup-É-key');
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('setup-É-key')));
 const h=btoa(String.fromCharCode(...digest)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 expect(await db.prepare('SELECT code_hash FROM setup_codes').first('code_hash')).toBe(h);expect(h).toHaveLength(43);
 const b=await begin(' setup-É-key ');expect(await owner.setupVerify(db,b.req,undefined,b.response)).toContain('__Host-sk_owner=');
 expect(await db.prepare('SELECT count(*) AS n FROM setup_codes').first('n')).toBe(0);expect(await owner.passkeyCount(db)).toBe(1);
 await expect(owner.issueSetupCode(db,'later')).rejects.toMatchObject({status:409,code:'claimed'});
});
for(const change of ['replace','expire'] as const)it(`refuses ${change} after WebAuthn but before atomic claim`,async()=>{
 await owner.issueSetupCode(db,'initial-setup-code');const b=await begin('initial-setup-code');let calls=0;
 const proxy=beforeBatch(async()=>{calls++;if(change==='replace')await owner.issueSetupCode(db,'replacement-code');else await db.prepare("UPDATE setup_codes SET expires_at='2000-01-01T00:00:00.000Z'").run();});
 await expect(owner.setupVerify(proxy,b.req,undefined,b.response)).rejects.toMatchObject({status:403,code:'code_expired'});
 expect(calls).toBe(1);expect(await db.prepare('SELECT count(*) AS n FROM owner').first('n')).toBe(0);expect(await owner.passkeyCount(db)).toBe(0);expect(await db.prepare('SELECT count(*) AS n FROM setup_codes').first('n')).toBe(1);
});
it('does not replace or delete codes if the site is claimed after issuance precheck',async()=>{
 await owner.issueSetupCode(db,'earlier-code');const h=await db.prepare('SELECT code_hash FROM setup_codes').first('code_hash');
 const proxy=beforeBatch(()=>db.prepare("INSERT INTO owner(id,name,user_handle,created_at) VALUES(1,'Owner','raced','2026-10-18')").run());
 await expect(owner.issueSetupCode(proxy,'later-code')).rejects.toMatchObject({status:409,code:'claimed'});
 expect(await db.prepare('SELECT code_hash FROM setup_codes').first('code_hash')).toBe(h);
});
it('binds new legacy-env challenges to the same secret but accepts old challenge format',async()=>{
 const b=await begin('old-env-code','old-env-code');await expect(owner.setupVerify(db,b.req,'new-env-code',b.response)).rejects.toMatchObject({status:403,code:'code_expired'});
 const legacy=await begin('old-env-code','old-env-code');await db.prepare("UPDATE challenges SET challenge=json_remove(challenge,'$.env_hash')").run();
 expect(await owner.setupVerify(db,legacy.req,'old-env-code',legacy.response)).toContain('__Host-sk_owner=');
});
it('serializes two valid claims and consumes every stored code once',async()=>{
 await owner.issueSetupCode(db,'one-owner-code');const a=await begin('one-owner-code'),b=await begin('one-owner-code');
 const results=await Promise.allSettled([owner.setupVerify(db,a.req,undefined,a.response),owner.setupVerify(db,b.req,undefined,b.response)]);
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);const failed=results.find(x=>x.status==='rejected') as PromiseRejectedResult;
 expect(failed.reason).toMatchObject({status:409,code:'claimed'});expect(await owner.passkeyCount(db)).toBe(1);expect(await db.prepare('SELECT count(*) AS n FROM setup_codes').first('n')).toBe(0);
});
