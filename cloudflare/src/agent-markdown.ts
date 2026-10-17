/** Mechanical text projection of visitor HTML. No fetching or agent directions. */
import { decodeHTML, decodeHTMLAttribute } from 'entities';
type Node = { tag:string; attrs:Record<string,string>; children:Node[]; text:string };
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const OMIT = new Set('script style nav form button input select textarea svg canvas iframe object template noscript'.split(' '));
const trim = (s:string) => s.replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g,'');
export const inlineText = (s:string) => trim(s.replace(/[ \t\r\n\f]+/g,' '));
export const mdText = (s:string) => s.replace(/[\\`*_{}\[\]()#+.!|~-]/g,'\\$&').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function hidden(n:Node):boolean {
  return OMIT.has(n.tag) || Object.hasOwn(n.attrs,'hidden') || n.attrs['aria-hidden']==='true' ||
    /(?:^|\s)sk-owner-link(?:\s|$)/.test(n.attrs.class??'') || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(n.attrs.style??'');
}
function parse(html:string):Node {
  const root:Node={tag:'root',attrs:{},children:[],text:''}, stack=[root];
  const tokens=html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</g)??[];
  for(const token of tokens) {
    if(token.startsWith('<!--')||token.startsWith('<!'))continue;
    const top=stack[stack.length-1].tag;
    if(['script','style','textarea'].includes(top)&&!new RegExp('^</'+top+'\\s*>$','i').test(token))continue;
    const end=/^<\/([a-zA-Z][\w:-]*)[^>]*>$/.exec(token);
    if(end){const tag=end[1].toLowerCase();for(let i=stack.length-1;i>0;i--)if(stack[i].tag===tag){stack.length=i;break;}continue;}
    const start=/^<([a-zA-Z][\w:-]*)([\s\S]*?)\/?\s*>$/.exec(token);
    if(start){const n:Node={tag:start[1].toLowerCase(),attrs:Object.create(null),children:[],text:''};
      for(const m of start[2].matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
        if(!Object.hasOwn(n.attrs,m[1].toLowerCase()))n.attrs[m[1].toLowerCase()]=decodeHTMLAttribute(m[2]??m[3]??m[4]??'');
      stack[stack.length-1].children.push(n);if(!VOID.has(n.tag)&&!token.endsWith('/>'))stack.push(n);
    }else stack[stack.length-1].children.push({tag:'',attrs:{},children:[],text:decodeHTML(token)});
  }
  return root;
}
function find(n:Node,tag:string, visible=true):Node|undefined {
  if(visible&&hidden(n))return;
  if(n.tag===tag)return n;
  for(const child of n.children){const found=find(child,tag,visible);if(found)return found;}
}
function children(n:Node,render:(child:Node)=>string):string {
  let result='',previous:Node|undefined;
  // Direct text distinguishes mixed prose from an element-only label group.
  const group=!n.children.some(c=>!c.tag&&!!inlineText(c.text));
  for(const child of n.children) {
    const value=render(child);if(!value)continue;
    if(group&&previous?.tag&&child.tag&&/[^ \t\r\n\f]$/.test(result)&&/^[^ \t\r\n\f]/.test(value))result+=' ';
    result+=value;previous=child;
  }
  return result;
}
function text(n:Node):string {return hidden(n)?'':n.text+children(n,text);}
export function agentURL(value:string,base:string):string {
  try{const u=new URL(value,base);if(!['https:','http:','mailto:','tel:'].includes(u.protocol)||u.username||u.password)return '';return u.href.replace(/[<>()]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);}catch{return '';}
}
/** Search sees the same visible document, never markup, URLs or owner controls. */
export function visibleDocumentText(html:string):string {
  const tree=parse(html),body=find(tree,'body')??tree,main=find(body,'main')??body;
  const blocks=new Set('address article aside blockquote br caption dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li main ol p pre section table td th tr ul'.split(' '));
  const read=(n:Node):string=>{if(hidden(n))return '';if(n.tag==='img')return inlineText(n.attrs.alt??'');const value=n.text+children(n,read);return blocks.has(n.tag)?' '+value+' ':value;};
  const footer=find(body,'footer');return inlineText(read(main)+(footer&&!find(main,'footer')?' '+read(footer):''));
}
export function markdownDocument(html:string,canonical:string):{title:string;description:string;markdown:string} {
  const tree=parse(html),body=find(tree,'body')??tree,main=find(body,'main')??body;
  const titleNode=find(main,'h1'), title=inlineText(text(titleNode??find(tree,'title',false)??{tag:'',attrs:{},children:[],text:''}));
  let description='';
  const meta=(n:Node)=>{if(n.tag==='meta'&&n.attrs.name?.toLowerCase()==='description')description=inlineText(n.attrs.content??'');n.children.forEach(meta);};meta(tree);
  if(description&&!inlineText(text(body)).includes(description))description='';
  function render(n:Node,depth=0):string {
    if(depth>128||hidden(n)||n===titleNode)return '';
    if(!n.tag)return mdText(n.text.replace(/[ \t\r\n\f]+/g,' '));
    const inner=()=>children(n,c=>render(c,depth+1));
    if(n.tag==='head'||(main===body&&n.tag==='header'))return '';
    if(n.tag==='pre'){const content=text(n).replace(/\r\n?/g,'\n').replace(/\n$/,'');const ticks='`'.repeat(Math.max(3,...[...content.matchAll(/`+/g)].map(m=>m[0].length+1)));const lang=/(?:^|\s)language-([a-zA-Z0-9_+-]{1,32})(?:\s|$)/.exec(find(n,'code')?.attrs.class??'')?.[1]??'';return `\n\n${ticks}${lang}\n${content}\n${ticks}\n\n`;}
    if(n.tag==='code'){const content=text(n);const ticks='`'.repeat(Math.max(1,...[...content.matchAll(/`+/g)].map(m=>m[0].length+1)));return `${ticks} ${content} ${ticks}`;}
    if(n.tag==='img'){const url=agentURL(n.attrs.src??'',canonical);return url?`![${mdText(inlineText(n.attrs.alt??''))}](<${url}>)`:'';}
    if(n.tag==='a'){const label=trim(inner())||mdText(inlineText(n.attrs['aria-label']??''));const url=agentURL(n.attrs.href??'',canonical);return url?`[${label||mdText(url)}](<${url}>)`:label;}
    if(n.tag==='br')return '\n';
    if(n.tag==='hr')return '\n\n---\n\n';
    if(/^h[1-6]$/.test(n.tag))return `\n\n${'#'.repeat(Number(n.tag[1]))} ${trim(inner())}\n\n`;
    if(['strong','b','em','i'].includes(n.tag)){const value=inner(),mark=['strong','b'].includes(n.tag)?'**':'*';return value?mark+value+mark:'';}
    if(n.tag==='blockquote')return '\n\n'+trim(inner()).split('\n').map(line=>'> '+line).join('\n')+'\n\n';
    if(['ul','ol'].includes(n.tag))return '\n\n'+n.children.filter(c=>c.tag==='li'&&!hidden(c)).map((c,i)=>`${n.tag==='ol'?`${i+1}.`:'-'} ${trim(render(c,depth+1)).replace(/\n/g,'\n  ')}`).join('\n')+'\n\n';
    const value=inner();
    return ['p','div','dl','dt','dd','section','article','aside','figure','figcaption','header','footer','summary','tr'].includes(n.tag)?`\n\n${trim(value)}\n\n`:n.tag==='td'||n.tag==='th'?value+' | ':value;
  }
  const footer=find(body,'footer'), extra=footer&&!find(main,'footer')?render(footer):'';
  const content=trim((description&&!inlineText(text(main)).includes(description)?mdText(description)+'\n\n':'')+render(main)+extra).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n');
  return {title,description,markdown:(title?'# '+mdText(title)+'\n\n':'')+'<'+agentURL(canonical,canonical)+'>\n\n'+content+'\n'};
}
