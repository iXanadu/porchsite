import {databaseIdentity} from './daily-limit';
/** Aggregate-only request accounting; no request identifiers leave this module. */
import table from "../../server/server/app/agent-traffic.json";
import { esc as escapeHTML } from "./html";
import { dateFormatter } from "./date-format";
import { markdownPath, publicPath, sessionRequest } from "./public-http";
export type AgentKind = "search" | "training" | "user" | "other";
export interface TrafficRow { day: string; kind: AgentKind; requests: number }
export const CLASSIFICATION = table;
const agents = new Map(table.agents.map(a => [a.token.toLowerCase(), a.kind as AgentKind]));
const types = new Set(["text/html; charset=utf-8", "text/markdown; charset=utf-8", "text/plain; charset=utf-8", "application/atom+xml; charset=utf-8", "application/xml; charset=utf-8"]);

export function agentKind(ua: string): AgentKind {
  if (!ua || [...ua].length > 4096) return "other";
  const kinds = new Set<AgentKind>();
  for (const token of ua.match(/[!#$%&'*+.^_`|~0-9A-Za-z-]+/g) ?? []) {
    const kind = agents.get(token.toLowerCase()); if (kind) kinds.add(kind);
  }
  return kinds.size === 1 ? [...kinds][0] : "other";
}
export function countable(req: Request, response: Response): boolean {
  if (req.method!=="GET" || response.status!==200 || sessionRequest(req)) return false;
  const path = new URL(req.url).pathname;
  if (/^\/(?:review|login|setup|recover|invite|passkey|upload|authorize|oauth|mcp|static|alerts|collect|health|\.well-known)(?:\/|$)/.test(path)) return false;
  return (publicPath(path) || !!markdownPath(path) || path === "/llms.txt") && types.has(response.headers.get("Content-Type") ?? "");
}
type BufferState={pending:Map<string,number>;last:number;flight?:Promise<void>};
const buffers=new WeakMap<D1Database,BufferState>();
function buffer(db:D1Database){db=databaseIdentity(db);let state=buffers.get(db);if(!state){state={pending:new Map(),last:-Infinity};buffers.set(db,state);}return state;}
export function reset(db:D1Database){buffers.delete(databaseIdentity(db));}
function add(state:BufferState,key:string,count:number){state.pending.set(key,(state.pending.get(key)??0)+count);while(state.pending.size>8)state.pending.delete(state.pending.keys().next().value!);}
export async function flush(db:D1Database,now=Date.now()):Promise<void>{
 const state=buffer(db);if(state.flight)return state.flight;if(!state.pending.size||now-state.last<60000)return;
 const rows=[...state.pending];state.pending.clear();state.last=now;
 const work=async()=>{try{const values=rows.map(()=>'(?, ?, ?)').join(',');await db.prepare(`INSERT INTO agent_traffic_daily(day,kind,requests) VALUES ${values} ON CONFLICT(day,kind) DO UPDATE SET requests=agent_traffic_daily.requests+excluded.requests`).bind(...rows.flatMap(([key,count])=>[...key.split('\0'),count])).run();}catch{for(const [key,count]of rows)add(state,key,count);}};
 state.flight=work();try{await state.flight;}finally{state.flight=undefined;}
}
export async function observe(db:D1Database,req:Request,response:Response,now=new Date(),timezone?:string):Promise<void>{
 if(!countable(req,response))return;
 if(timezone===undefined){const row=await db.prepare("SELECT data FROM live WHERE item_id = 'site'").first<{data:string}>();timezone=row?String(JSON.parse(row.data).timezone||'UTC'):'UTC';}
 const parts=dateFormatter({year:'numeric',month:'2-digit',day:'2-digit'},timezone).formatToParts(now),part=(name:string)=>parts.find(p=>p.type===name)!.value;
 const day=`${part('year')}-${part('month')}-${part('day')}`;
 add(buffer(db),day+'\0'+agentKind(req.headers.get('User-Agent')??''),1);
 await flush(db,now.getTime());
}
export function formatTraffic(rows: TrafficRow[], start: string, end: string) {
  const order = table.kinds.map(k=>k.id);
  const daily = rows.filter(r=>r.day>=start&&r.day<=end).map(r=>({day:r.day,kind:r.kind,requests:Number(r.requests)})).sort((a,b)=>a.day.localeCompare(b.day)||order.indexOf(a.kind)-order.indexOf(b.kind));
  return {classification_version:table.version,range:{start,end},daily,totals:table.kinds.map(k=>({kind:k.id,label:k.label,requests:daily.filter(r=>r.kind===k.id).reduce((sum,r)=>sum+r.requests,0)})),coverage:table.coverage,classification:table.classification,scope:table.scope};
}
export async function trafficReport(db: D1Database, start: string, end: string) {
  const state=buffer(db);await state.flight;
  const {results}=await db.prepare("SELECT day, kind, requests FROM agent_traffic_daily WHERE day BETWEEN ? AND ? ORDER BY day, kind").bind(start,end).all<TrafficRow>();
  const merged=new Map(results.map(r=>[r.day+'\0'+r.kind,Number(r.requests)]));
  for(const [key,count]of state.pending)merged.set(key,(merged.get(key)??0)+count);
  return formatTraffic([...merged].map(([key,requests])=>{const [day,kind]=key.split('\0');return {day,kind:kind as AgentKind,requests};}),start,end);
}

/** Owner-requested facts only; the labels and limitations come from the shared table. */
export function trafficHTML(report: ReturnType<typeof formatTraffic>): string {
  const totals = report.totals.map(r=>`<div class="row"><span>${escapeHTML(r.label)}</span><span>${r.requests} requests</span></div>`).join("");
  const daily = report.daily.length ? `<table><thead><tr><th>Day</th><th>Kind</th><th>Requests</th></tr></thead><tbody>${report.daily.map(r=>`<tr><td>${escapeHTML(r.day)}</td><td>${escapeHTML(report.totals.find(k=>k.kind===r.kind)!.label)}</td><td>${r.requests}</td></tr>`).join("")}</tbody></table>` : '<p class="meta">No observed public requests in this range.</p>';
  return `<h2 class="sub">Requests by agent kind</h2><p class="meta">${escapeHTML(report.coverage)} ${escapeHTML(report.classification)} ${escapeHTML(report.scope)}</p><div class="card">${totals}</div>${daily}`;
}
