/** Shared UC9 classification, report and owner HTML contract. */
import cases from "../../spec/agent-traffic-cases.json";
import {agentKind,formatTraffic,trafficHTML,type TrafficRow} from "../src/agent-traffic";
const report=formatTraffic(cases.rows as TrafficRow[],"2026-10-16","2026-10-17");
const kinds=cases.agents.map(c=>{const kind=agentKind(c.ua);if(kind!==c.kind)throw Error("classification differs");return kind;});
console.log(JSON.stringify({kinds,report,html:trafficHTML(report)}));
