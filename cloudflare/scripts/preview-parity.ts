// Same content primitives and inert serializer as preview_read; no HTTP grant.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {THEMES} from '../src/themes.gen';
import {sampleView} from '../src/themecheck';
import {inert,renderPage} from '../src/preview-read';
import {markdownDocument} from '../src/agent-markdown';
async function main(){
 const root=process.argv[2],origin='https://example.com',now=new Date('2026-10-15T15:30:00Z'),out=[];
 for(const name of Object.keys(THEMES).sort()){
  const sample=JSON.parse(readFileSync(join(root,'themes',name,'sample.json'),'utf8')),t=THEMES[name],v=sampleView(t,sample,now);v.site.archive={enabled:true,title:'All entries'};
  const stream=v.site.streams[0],paths=['/','/archive/',`/${stream.path||stream.id}/`,...v.entries.filter(e=>!e.external_url).slice(0,1).map(e=>e.page)];
  for(const path of paths){const html=inert(await renderPage(v,t,path,origin,'test'));out.push({name,path,html,markdown:markdownDocument(html,origin+path,false).markdown});}
 }
 process.stdout.write(JSON.stringify(out)+'\n');
}
void main();
