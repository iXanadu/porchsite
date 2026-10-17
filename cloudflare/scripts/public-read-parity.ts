import data from '../../spec/fixtures/public-dependencies.json';
import {decode,choice,tag} from '../src/public-read';
async function main(){const f=decode(data.rows);const result=[];for(const path of data.paths){const req=new Request(data.origin+path),c=choice(req,f);result.push({path,tag:c?await tag(f,req,c,data.release,data.now):null});}console.log(JSON.stringify(result));}
main().catch(e=>{console.error(e);process.exitCode=1;});
