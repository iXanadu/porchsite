/** Fail-closed source inventory for the reviewed D1 mutation result contracts. */
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(join(root,'cloudflare/package.json'));
const {parse}=require('@babel/parser');
const hash=s=>createHash('sha256').update(s).digest('hex');
export function sources(at=root){
 const base=join(at,'cloudflare/src'),files=[];
 function visit(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
  const path=join(dir,entry.name);if(entry.isDirectory())visit(path);
  else if(/\.(?:[cm]?js|tsx?)$/.test(entry.name))files.push(path);
 }}
 visit(base);return Object.fromEntries(files.sort().map(path=>[path.slice(base.length+1),readFileSync(path,'utf8')]));
}
function key(node){
 if(!node)return null;
 if(node.type==='Identifier')return node.name;
 if(node.type==='StringLiteral')return node.value;
 if(node.type==='BinaryExpression'&&node.operator==='+'){const a=key(node.left),b=key(node.right);return a!==null&&b!==null?a+b:null;}
 return null;
}
export function capture(input){
 const inventory={},names=new Set(['meta','changes','rowsAffected','rows_affected','rowCount']);
 for(const [name,text] of Object.entries(input)){
  const file=parse(text,{sourceType:'module',plugins:['typescript']}),spans=new Map();
  function walk(node,fn=file.program){
   if(!node||typeof node!=='object')return;
   if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ObjectMethod','ClassMethod'].includes(node.type))fn=node;
   const member=['MemberExpression','OptionalMemberExpression'].includes(node.type)&&names.has(key(node.property));
   const binding=node.type==='ObjectProperty'&&names.has(key(node.key));
   // Also inventory numeric one comparisons even through aliases or unknown
   // computed access. New unclassified provenance cannot evade the inventory
   // by spelling meta/changes differently or destructuring the result first.
   const one=node.type==='BinaryExpression'&&['===','!==','==','!='].includes(node.operator)&&[node.left,node.right].some(x=>x?.type==='NumericLiteral'&&x.value===1);
   if(member||binding||one)spans.set(fn.start,fn);
   for(const [key,value] of Object.entries(node))if(!['loc','extra','tokens','comments'].includes(key)){
    if(Array.isArray(value))for(const child of value)walk(child,fn);
    else if(value&&typeof value==='object')walk(value,fn);
   }
  }
  walk(file.program);
  const sorted=[...spans.values()].sort((a,b)=>a.start-b.start);
  for(const [i,fn] of sorted.entries())inventory[`${name}:${fn.id?.name??fn.key?.name??`anonymous-${i}`}`]=hash(text.slice(fn.start,fn.end));
 }
 return inventory;
}
export function itemsDependencies(sql){
 // Lex quoted SQL values as units: text inside a JSON/string literal cannot
 // masquerade as a dependency, JOIN or identifier.
 const tokens=(sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g)??[]).filter(x=>!x.startsWith("'")).map(x=>x.toLowerCase());
 const joins=[];
 for(let i=0;i<tokens.length;i++)if(tokens[i]==='items'){
  if(tokens[i-1]!=='join'||tokens[i+1]!=='i'||tokens.slice(i+2,i+9).join(' ')!=='on i . id = l .')throw Error('Unreviewed items relation or alias');
  if(tokens[i+9]!=='item_id')throw Error('Unreviewed items join key');joins.push(i);
 }
 if(joins.length!==1)throw Error('Expected exactly one reviewed items join');
 const columns=[];for(let i=0;i<tokens.length-2;i++)if(tokens[i]==='i'&&tokens[i+1]==='.')columns.push(tokens[i+2]);
 if(columns.length!==2||[...columns].sort().join(',')!=='created_at,id')throw Error('Unreviewed Q_F items dependency');
 return ['id','created_at'];
}
export function verify(input,contract,serverRelation,template){
 // Complete module bytes and membership close obfuscated/computed access and
 // module-scope alias changes that a recognized-function scan cannot prove.
 // Any runtime source change requires deliberate inventory review; there is no
 // automatic updater or best-effort provenance exception.
 const modules=Object.fromEntries(Object.entries(input).map(([name,text])=>[name,hash(text)]));
 if(JSON.stringify(Object.entries(modules).sort())!==JSON.stringify(Object.entries(contract.modules).sort()))throw Error('Unreviewed runtime module or mutation provenance');
 const actual=capture(input);
 if(JSON.stringify(Object.entries(actual).sort())!==JSON.stringify(Object.entries(contract.functions).sort()))throw Error('Unreviewed mutation metadata provenance, SQL, comparison or batch slot');
 const relation=input['public-read.ts'].match(/export const FACTS_RELATION=(`[^]*?`);\nexport const FACTS_SQL=/)?.[1];
 if(!relation||hash(relation)!==contract.facts_sha256)throw Error('Unreviewed complete Q_F relation');
 itemsDependencies(relation);itemsDependencies(serverRelation);
 if(hash(serverRelation)!==contract.server_facts_sha256)throw Error('Unreviewed server Q_F relation');
 const expected='WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at';
 if(!template.includes(expected)||hash(template)!==contract.trigger_template_sha256)throw Error('Unreviewed trigger predicate or exact-body template');
 return true;
}
export function inputs(at=root){return {input:sources(at),serverRelation:readFileSync(join(at,'server/server/app/public_read.py'),'utf8').match(/FACTS_RELATION = '''([^]*?)'''/)?.[1],template:readFileSync(join(at,'scripts/content_revision_sql.py'),'utf8')};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const v=inputs(),contract=JSON.parse(readFileSync(join(root,'spec/fixtures/witness-compat.json'),'utf8'));
 verify(v.input,contract,v.serverRelation,v.template);console.log('Witness mutation-count and Q_F dependency inventory: PASS');
}
