/** Private gate parity without content/existence methods on its database. */
import {readFileSync} from 'node:fs';
import {access} from '../src/privacy';
const fixture=JSON.parse(readFileSync('../spec/fixtures/private-denial.json','utf8'));
const fields=['cache-control','content-type','content-security-policy','x-robots-tag','x-content-type-options','location','etag','last-modified','link','vary'];
const db={prepare(sql:string){if(!sql.includes('site_fields')&&!sql.includes('sessions'))throw Error('Content lookup before denial');return {bind(){return this;},async first(){return sql.includes('site_fields')?{value:'true'}:null;}};}} as unknown as D1Database;
(async()=>{
 const out=[];
 for(const path of fixture.paths)for(const accept of fixture.accept)for(const auth of [null,...fixture.authorization])for(const method of ['GET','HEAD']){
  const headers:Record<string,string>={Accept:accept,'If-None-Match':'*'};if(auth!==null)headers.Authorization=auth;
  const r=(await access(db,new Request('https://example.com'+path,{method,headers}))).response!;
  out.push({path,accept,auth,method,status:r.status,body:method==='HEAD'?'':await r.text(),headers:Object.fromEntries(fields.map(k=>[k,r.headers.get(k)]))});
 }
 console.log(JSON.stringify(out));
})().catch(error=>{console.error(error);process.exit(1);});
