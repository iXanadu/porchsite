import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {CLOCK,hash} from './fixtures.mjs';
export const OPERATIONS=['collect/first_day','collect/repeat','collect/at_cap','collect/heartbeat','approval/one','approval/200','import/file'];
export const WRITE_MANIFEST={version:1,operations:OPERATIONS,expected_cap:true,uncapped_archives:[],heartbeat:{e:1000,d:25},approval_counts:[1,200],import_items:3};
export const quote=x=>x===null?'NULL':"'"+String(x).replaceAll("'","''")+"'";
export const digest=x=>createHash('sha256').update(x).digest('base64url');
export const DAY=CLOCK.slice(0,10),SALT='synthetic-daily-salt',UA='Mozilla/5.0 SyntheticBrowser',IP='192.0.2.40';
export const VISITOR=hash(SALT+IP+'\n'+UA).slice(0,32);
const dayMinus=n=>new Date(Date.parse(CLOCK)-86400000*n).toISOString().slice(0,10);
export function viewSQL(id,day=DAY,visitor=VISITOR,created=CLOCK) {
 return `INSERT INTO pageviews(id,day,visitor,path,kind,ref_bucket,created_at,updated_at) VALUES(${[id,day,visitor,'/','entry','direct',created,created].map(quote)});`;
}
export function writeFixture(root,operation,token) {
 const sample=JSON.parse(fs.readFileSync(path.join(root,'themes/services-page/sample.json'),'utf8'));
 const entry=sample.items.find(x=>x.kind==='entry').data,card=sample.items.find(x=>x.kind==='card').data;
 const base=JSON.parse(JSON.stringify(entry));base.external_url='';delete base.event;delete base.embed;delete base.cover;const importCard={...card,link:'',link_label:''};
 const data=i=>({...base,title:'Write fixture '+String(i).padStart(3,'0')});
 const id=i=>'en_'+i.toString(16).padStart(8,'0');
 const approval='row_approval_fixture';let sql='',body={t:'pv',id:'view_attempt_201',p:'/',k:'entry'},ids=[];
 if(operation.startsWith('collect/')) {
  sql+='DELETE FROM pageviews; DELETE FROM analytics_salts; DELETE FROM analytics_daily;';
  if(operation==='collect/first_day') {
   sql+=`UPDATE analytics_maintenance SET completed_day=${quote(dayMinus(1))} WHERE id=1;`;
   sql+=`INSERT INTO analytics_salts(day,salt) VALUES(${quote(dayMinus(1))},${quote(SALT)});`;
   sql+=viewSQL('expired_view_001',dayMinus(91),hash('old-visitor').slice(0,32),dayMinus(91)+'T12:00:00.000Z')+viewSQL('expired_view_002',dayMinus(91),hash('old-visitor').slice(0,32),dayMinus(91)+'T12:00:00.000Z')+viewSQL('retained_view_01',dayMinus(1),hash('retained-visitor').slice(0,32),dayMinus(1)+'T12:00:00.000Z');
  } else {
   sql+=`UPDATE analytics_maintenance SET completed_day=${quote(DAY)} WHERE id=1; INSERT INTO analytics_salts(day,salt) VALUES(${quote(DAY)},${quote(SALT)});`;
   const count=operation==='collect/at_cap'?200:1;
   for(let i=0;i<count;i++)sql+=viewSQL('existing_view_'+String(i).padStart(3,'0'),DAY,VISITOR,new Date(Date.parse(CLOCK)-1000).toISOString());
   if(operation==='collect/heartbeat')body={t:'hb',id:'existing_view_000',e:1000,d:25};
  }
 } else {
  sql+=`INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(${quote(digest(token))},${quote(new Date(Date.parse(CLOCK)-60000).toISOString())},${quote(new Date(Date.parse(CLOCK)+86400000).toISOString())});`;
  if(operation.startsWith('approval/')) {
   const n=operation==='approval/200'?200:1;
   for(let i=0;i<n;i++) {
    const ident=id(100000+i),serialized=JSON.stringify(data(i));ids.push(ident);
    sql+=`INSERT INTO items(id,kind,slug,version,data,deleted,created_at,updated_at) VALUES(${[ident,'entry','write-'+i,1,serialized,0,CLOCK,CLOCK].map(quote)});`;
    sql+=`INSERT INTO revisions(item_id,version,action,data,deleted,actor,reason,created_at) VALUES(${[ident,1,'create',serialized,0,'assistant:fixture','Synthetic fixture',CLOCK].map(quote)});`;
   }
   const items=ids.map((ident,i)=>({id:ident,version:1,kind:'entry',label:data(i).title,change:'new',status:'pending',note:''}));
   sql+=`INSERT INTO approvals(id,items,note,requested_by,status,decision_note,created_at) VALUES(${[approval,JSON.stringify(items),'Synthetic changes','assistant:fixture','pending','',CLOCK].map(quote)});`;
  }
 }
 const file=JSON.stringify({porchsite_import:1,from:'fixture',note:'Synthetic import',items:[{kind:'site',data:{title:'Imported site title'}},{kind:'entry',data:data(0)},{kind:'card',data:importCard}],images:{}});
 return {sql,body:JSON.stringify(body),file,approval,ids,first_expired_day:dayMinus(91)};
}
