/** Fixed Unicode 15.1 normalization/search casing, independent of runtime ICU. */
import table from '../../server/server/app/read-unicode.json';
const data=table as {decomp:Record<string,number[]>;classes:Record<string,number>;compose:Record<string,number>;lower:Record<string,string>;cased:number[];ignorable:number[]};
const cc=(n:number)=>data.classes[n]??0;
function expand(n:number,out:number[]){
 const h=n-0xac00;if(h>=0&&h<11172){out.push(0x1100+Math.floor(h/588),0x1161+Math.floor(h%588/28));if(h%28)out.push(0x11a7+h%28);return;}
 const d=data.decomp[n];if(d)for(const c of d)expand(c,out);else out.push(n);
}
function pair(a:number,b:number):number|undefined{
 if(a>=0x1100&&a<0x1113&&b>=0x1161&&b<0x1176)return 0xac00+(a-0x1100)*588+(b-0x1161)*28;
 if(a>=0xac00&&a<0xd7a4&&(a-0xac00)%28===0&&b>0x11a7&&b<0x11c3)return a+b-0x11a7;
 return data.compose[a+','+b];
}
export function readNFC(value:string):string{
 const raw:number[]=[];for(const c of value)expand(c.codePointAt(0)!,raw);
 const ordered:number[]=[];let marks:number[]=[];
 const flush=()=>{marks.sort((a,b)=>cc(a)-cc(b));for(const n of marks)ordered.push(n);marks=[];};
 for(const n of raw){if(!cc(n)){flush();ordered.push(n);}else marks.push(n);}flush();
 const out:number[]=[];let starter=-1,last=0;
 for(const n of ordered){const cls=cc(n),joined=starter<0?undefined:pair(out[starter],n);if(joined!==undefined&&(last===0||last<cls))out[starter]=joined;else{if(!cls)starter=out.length;out.push(n);last=cls;}}
 return out.map(n=>String.fromCodePoint(n)).join('');
}
const cased=new Set(data.cased),ignorable=new Set(data.ignorable);
/** Unicode default lowercase, including the contextual Final_Sigma rule. */
export function readNormalize(value:string){
 const chars=[...readNFC(value)],codes=chars.map(c=>c.codePointAt(0)!);
 return chars.map((c,i)=>{if(codes[i]===0x3a3){let left=i-1,right=i+1;while(left>=0&&ignorable.has(codes[left]))left--;while(right<codes.length&&ignorable.has(codes[right]))right++;if(left>=0&&cased.has(codes[left])&&(right===codes.length||!cased.has(codes[right])))return 'ς';}return data.lower[codes[i]]??c;}).join('');
}
