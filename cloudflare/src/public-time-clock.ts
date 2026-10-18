/** Finite IANA rules shared by renderer and proof; unknown clocks remain live-only. */
import table from '../../server/server/spec/public-time-zones.json';
const data=table as {start:number;zones:Record<string,number>;rules:string[]};
const decoded=new Map<number,[number,number,number[][]]>();
export function rules(zone:string,now:number){if(!Object.hasOwn(data.zones,zone))return null;const i=data.zones[zone];let r=decoded.get(i);if(!r){r=JSON.parse(data.rules[i]) as [number,number,number[][]];if(decoded.size>=8)decoded.delete(decoded.keys().next().value!);decoded.set(i,r);} return r&&now>=data.start*1000&&now<r[0]*1000?r:null;}
export function offset(r:NonNullable<ReturnType<typeof rules>>,now:number){let value=r[1];for(const [at,n] of r[2]){if(at*1000>now)break;value=n;}return value;}
export function wall(now:number,zone:string){const r=rules(zone,now);if(!r)return null;const d=new Date(now+offset(r,now)*1000),s=d.toISOString();return {date:s.slice(0,10),time:s.slice(11,16),day:['sun','mon','tue','wed','thu','fri','sat'][d.getUTCDay()]};}
/** Resolve all occurrences; a gap has none. Transitions themselves are separate candidates. */
export function occurrences(stamp:string,zone:string,now:number){const r=rules(zone,now);if(!r)return [];const local=Date.parse(stamp+'Z');if(!Number.isFinite(local))return [];return [...new Set([r[1],...r[2].map(x=>x[1])])].map(n=>local-n*1000).filter(at=>rules(zone,at)&&offset(r,at)===(local-at)/1000);}
