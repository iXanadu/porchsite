/** Extended stream fixtures, independent of the looks' unchanged samples. */
import {readFileSync,writeFileSync} from 'node:fs';
import {THEMES} from '../src/themes.gen';
import {sampleView,renderSample} from '../src/themecheck';
import {allArchivePage} from '../src/site';
import {archiveFilter} from '../src/archive';
import {feed,searchIndex} from '../src/theme';
import {sitemap} from '../src/sitemap';
const [fixture,output]=process.argv.slice(2), input=JSON.parse(readFileSync(fixture,'utf8'));
const out:Record<string,any>={}, origin='https://example.com', now=new Date('2026-10-15T15:30:00Z');
for(const [name,t] of Object.entries(THEMES)){
 const v=sampleView(t as any,input,now);
 out[name]=renderSample(t as any,input,origin,now);
 for(const query of ['', 'sort=stream','tag=report','stream=part-8','tag=report&stream=part-8','tag=missing','stream=missing']){
  const response=allArchivePage(v,archiveFilter(new URLSearchParams(query)),origin);
  out[name]['archive?'+query]={body:await response.text(),headers:Object.fromEntries(['content-type','cache-control','content-security-policy','permissions-policy','referrer-policy','x-content-type-options'].map(key=>[key,response.headers.get(key)]))};
 }
 out[name].fallback=await allArchivePage(v,{sort:"date",tag:"",stream:""},origin,false).text();
 out[name].sitemap=sitemap(v,origin);
 for(const path of ['part-0','part-8']){
  out[name][path+'.feed']=await feed(v,path,origin)!.text();
  out[name][path+'.search']=await searchIndex(v,path)!.json();
 }
}
writeFileSync(output,JSON.stringify(out));
