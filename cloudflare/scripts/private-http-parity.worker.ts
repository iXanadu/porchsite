// Native D1 private HTTP parity, fixed published sample sites and principal id.
import {env} from 'cloudflare:workers';
import {it,expect,vi} from 'vitest';
import {validate} from '../src/content';
import {storedData} from '../src/embed-storage';
import {handle} from '../src/routes';
import {liveView} from '../src/site';
import type {Env} from '../src/env';
const e=env as unknown as Env&{PARITY_CASES:string;PARITY_NOW:string;PARITY_OUTPUT:string};
const fields=['content-type','cache-control','content-security-policy','etag','link','vary','x-robots-tag','content-signal','last-modified'];
it('private published HTTP representations match every sample',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(e.PARITY_NOW));
 try{for(const c of JSON.parse(e.PARITY_CASES)){
  await e.DB.batch(['items','live','themes','site_embed_sources','site_fields','private_approvals','site_stream_settings','training_approvals','agent_read_keys'].map(table=>e.DB.prepare(`DELETE FROM ${table}`)));
  const rows=[{id:'site',kind:'site',slug:null,data:validate('site',{...c.sample.site,theme:c.theme,private:true})},...c.sample.items.map((item:any,i:number)=>({id:'i'+i,kind:item.kind,slug:item.kind==='entry'?item.slug??'item-'+i:null,data:validate(item.kind,item.data)}))];
  await e.DB.batch(rows.flatMap((row:any,i:number)=>{
   const at=new Date(Date.UTC(2026,9,10,12,0,i)).toISOString(),raw=JSON.stringify(storedData(row.kind,row.data));
   return [e.DB.prepare('INSERT INTO items(id,kind,slug,version,data,deleted,created_at,updated_at) VALUES(?,?,?,1,?,0,?,?)').bind(row.id,row.kind,row.slug,raw,at,at),e.DB.prepare('INSERT INTO live(item_id,kind,slug,version,data,published_at) VALUES(?,?,?,1,?,?)').bind(row.id,row.kind,row.slug,raw,at)];
  }));
  await e.DB.batch([e.DB.prepare("INSERT INTO site_fields(version,key,value,approved) VALUES(1,'private','true',1)"),e.DB.prepare('INSERT INTO private_approvals(version) VALUES(1)'),e.DB.prepare('INSERT INTO site_embed_sources(version,sources,approved) VALUES(1,?,1)').bind(JSON.stringify(rows[0].data.embed_sources??[]))]);
  const token='prk_'+'A'.repeat(32),hex=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  await e.DB.prepare("INSERT INTO agent_read_keys(id,name,key_hash,created_at,expires_at,owner_epoch) SELECT 'read_parity','Reader',?,'2026-10-10','2099-01-01',owner_epoch FROM auth_state WHERE id=1").bind(hex).run();
  const v=await liveView(e.DB),paths=[...new Set(['/',...v.site.streams.flatMap((s:any)=>['/'+(s.path||s.id)+'/',...v.entries.filter(x=>x.stream===s.id&&!x.external_url).map(x=>x.page)]),...(v.site.archive?.enabled?['/archive/']:[])])],out:any[]=[];
  for(const p of [...paths,'/llms.txt']){
   const copy=p==='/llms.txt'?p:p+'index.md';
   let tag='';
   for(const [path,method,extra] of [[p,'GET',{}],[copy,'GET',{}],[copy,'HEAD',{}],[p,'GET',{Accept:'text/markdown'}],[copy,'GET',{'If-None-Match':'@tag'}]] as [string,string,Record<string,string>][]){
    const headers={Authorization:'Bearer '+token,...extra};if(headers['If-None-Match']==='@tag')headers['If-None-Match']=tag;
    const r=await handle(new Request('https://example.invalid'+path,{method,headers}),e),body=await r.text();
    if(path===copy&&method==='GET'&&!extra['If-None-Match'])tag=r.headers.get('ETag')??'';
    out.push({path,method,extra,status:r.status,headers:Object.fromEntries(fields.map(k=>[k,r.headers.get(k)])),body});
   }
  }
  expect(await e.DB.prepare('SELECT count(*) n FROM public_artifacts').first('n')).toBe(0);
  await expect(JSON.stringify(out,null,2)+'\n').toMatchFileSnapshot(`${e.PARITY_OUTPUT}/${c.name}.json`);
 }}finally{vi.useRealTimers();}
},120000);
