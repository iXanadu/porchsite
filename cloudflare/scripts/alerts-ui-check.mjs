// Isolated browser-API tests. These do not claim vendor enrollment or OS delivery.
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
const source=readFileSync(new URL("../src/alert-assets.ts",import.meta.url),"utf8");
const script=JSON.parse(source.match(/^export const ALERT_JS=(.*);$/m)[1]);
const vector=JSON.parse(readFileSync(new URL("../../spec/fixtures/web-push.json",import.meta.url),"utf8"));
const data={endpoint:"https://fcm.googleapis.com/push/test",keys:{p256dh:vector.p256dh,auth:vector.auth}};
const fingerprint=value=>createHash("sha256").update([new URL(value.endpoint).href,value.keys.p256dh,value.keys.auth].join("\n")).digest("base64url");
function browser({saved=true,subscribed=true,matching=true,permission="granted",supported=true,save=true,ua="",touch=0}={}) {
 let subscription,unsubscribed=0,requests=0;
 const events={},calls=[];
 const line={textContent:"waiting"},error={hidden:true,textContent:""},button={disabled:false,textContent:"",addEventListener:(name,fn)=>events[name]=fn};
 const sub={toJSON:()=>data,unsubscribe:async()=>{subscription=null;unsubscribed++;return true;}};
 subscription=subscribed?sub:null;
 const root={dataset:{device:saved?"device":"",csrf:"CSRF",fingerprint:matching?fingerprint(data):"wrong"},querySelector:q=>q==="[data-alert-status]"?line:q==="[data-alert-toggle]"?button:error};
 const manager={getSubscription:async()=>subscription,subscribe:async()=>{subscription=sub;return sub;}};
 const registration={pushManager:manager};
 const Notification={permission,requestPermission:async()=>{requests++;return Notification.permission;}};
 const context={document:{getElementById:()=>root},navigator:supported?{userAgent:ua,maxTouchPoints:touch,serviceWorker:{getRegistration:async()=>registration,register:async()=>registration,ready:Promise.resolve(registration)}}:{},window:supported?{PushManager:class{},Notification}:{},Notification,crypto:webcrypto,TextEncoder,URL,Uint8Array,atob,btoa,fetch:async(path,options)=>{calls.push({path,options});if(path.endsWith('/key'))return {ok:true,json:async()=>({public_key:vector.p256dh})};return {ok:save,json:async()=>({id:"device"})};}};
 vm.runInNewContext(script,context);
 return {line,error,button,calls,click:()=>events.click(),permission:Notification,unsubscribed:()=>unsubscribed,requests:()=>requests};
}
async function ready(page){const until=Date.now()+1000;while(page.line.textContent==="waiting"&&Date.now()<until)await new Promise(r=>setTimeout(r,5));assert.notEqual(page.line.textContent,"waiting");}
for(const options of [{},{matching:false},{saved:false},{subscribed:false},{permission:"denied"}])test(`device status reconciles ${JSON.stringify(options)}`,async()=>{const page=browser(options);await ready(page);assert.equal(page.line.textContent,JSON.stringify(options)==="{}"?"Alerts are on for this device":"Alerts are off for this device");assert.equal(page.requests(),0);assert.equal(page.calls.length,0);});
test("unsupported devices get the iPhone steps and off status",async()=>{const page=browser({supported:false});await ready(page);assert.equal(page.line.textContent,"Alerts are off for this device");assert.equal(page.button.disabled,true);assert.match(page.error.textContent,/Share → Add to Home Screen/);});
test("turning off removes the server record and browser subscription",async()=>{const page=browser();await ready(page);await page.click();assert.equal(page.line.textContent,"Alerts are off for this device");assert.equal(page.calls[0].path,"/review/alerts/remove");assert.equal(page.calls[0].options.headers["X-CSRF"],"CSRF");assert.equal(page.unsubscribed(),1);});
test("turning on saves the browser subscription and displays on",async()=>{const page=browser({saved:false,subscribed:false});await ready(page);await page.click();assert.equal(page.requests(),1);assert.deepEqual(page.calls.map(c=>c.path),["/review/alerts/key","/review/alerts/subscribe"]);assert.equal(page.line.textContent,"Alerts are on for this device");});
test("permission refusal stays off with an explanation",async()=>{const page=browser({saved:false,permission:"denied"});await ready(page);await page.click();assert.equal(page.calls.length,0);assert.equal(page.error.hidden,false);assert.match(page.error.textContent,/permission/);assert.equal(page.line.textContent,"Alerts are off for this device");});
test("failed save removes the browser subscription and explains failure",async()=>{const page=browser({saved:false,subscribed:false,save:false});await ready(page);await page.click();assert.equal(page.unsubscribed(),1);assert.equal(page.error.hidden,false);assert.equal(page.line.textContent,"Alerts are off for this device");});

const workerScript=JSON.parse(source.match(/^export const SW_JS=(.*);$/m)[1]);
function serviceWorker(windows=[]) {
 const events={},shown=[],opened=[];
 const self={location:{origin:"https://site.example"},registration:{showNotification:async(...args)=>shown.push(args)},clients:{matchAll:async()=>windows,openWindow:async url=>opened.push(url)},addEventListener:(event,callback)=>events[event]=callback};
 vm.runInNewContext(workerScript,{self,URL});
 return {shown,opened,events,push:async value=>{let work;events.push({data:{json:()=>value},waitUntil:p=>work=p});await work;},click:async()=>{let work;events.notificationclick({notification:{data:{url:"https://other.example/"},close:()=>{}},waitUntil:p=>work=p});await work;}};
}
const message={message:"Your site has a change waiting for you",title:"Example site",url:"https://site.example/review"};
test("worker shows only the fixed notification fields, without grouping",async()=>{const sw=serviceWorker();await sw.push(message);assert.equal(sw.shown.length,1);assert.equal(sw.shown[0][0],"Example site");assert.equal(JSON.stringify(sw.shown[0][1]),JSON.stringify({body:message.message,data:{url:message.url}}));assert.equal(Object.hasOwn(sw.events,"fetch"),false);});
test("worker refuses malformed or cross-origin push payloads",async()=>{const sw=serviceWorker();for(const bad of [{...message,count:1},{...message,message:"Other text"},{...message,title:1},{...message,url:[message.url]},{...message,url:"https://other.example/review"},{...message,url:"https://site.example/review?approve=1"}])await sw.push(bad);assert.equal(sw.shown.length,0);});
test("notification click ignores supplied data and opens only this site's review",async()=>{const sw=serviceWorker();await sw.click();assert.deepEqual(sw.opened,[message.url]);});
test("notification click focuses an existing exact review window",async()=>{let focused=0;const sw=serviceWorker([{url:message.url,focus:async()=>focused++}]);await sw.click();assert.equal(focused,1);assert.deepEqual(sw.opened,[]);});

for (const [ua,touch,label] of [
 ["Mozilla iPhone AppleWebKit Version/18.0 Mobile Safari/604.1",0,"iPhone Safari"],
 ["Mozilla Macintosh Chrome/130.0 Safari/537.36",0,"Mac Chrome"],
 ["Mozilla Android Chrome/130.0 Mobile Safari/537.36",0,"Android Chrome"],
 ["Mozilla Macintosh Version/18.0 Safari/605.1",5,"iPad Safari"],
 ["Mozilla iPhone CriOS/130.0 Mobile Safari/604.1",0,"iPhone Chrome"],
 ["Mozilla Windows Chrome/130.0 Edg/130.0 Safari/537.36",0,"Windows Edge"],
 ["Unknown",0,"Browser"],
]) test(`enrollment derives the plain device label ${label}`,async()=>{
 const page=browser({saved:false,subscribed:false,ua,touch});await ready(page);await page.click();
 assert.equal(JSON.parse(page.calls.find(c=>c.path.endsWith('/subscribe')).options.body).label,label);
});

test("notification click navigates an existing login window and focuses the returned client",async()=>{
 const calls=[];
 const next={focus:async()=>calls.push('focus new')};
 const sw=serviceWorker([{url:'https://site.example/login?next=/review',navigate:async url=>{calls.push(url);return next;},focus:async()=>{throw Error('old client must not be focused');}}]);
 await sw.click();assert.deepEqual(calls,[message.url,'focus new']);assert.deepEqual(sw.opened,[]);
});
test("notification click prefers a focused same-origin window",async()=>{
 const calls=[];
 const client=url=>({url,navigate:async target=>{calls.push(url);assert.equal(target,message.url);return {focus:async()=>calls.push('focus')};}});
 const sw=serviceWorker([client('https://site.example/first'),{...client('https://other.example/review'),focused:true},{...client('https://site.example/review/request'),focused:true}]);
 await sw.click();assert.deepEqual(calls,['https://site.example/review/request','focus']);assert.deepEqual(sw.opened,[]);
});
test("notification click opens a window when only other origins are available",async()=>{
 const sw=serviceWorker([{url:'https://other.example/review',focused:true,navigate:async()=>{throw Error('must not use other origin');}}]);
 await sw.click();assert.deepEqual(sw.opened,[message.url]);
});
for(const failure of ['navigate throws','navigate null','focus throws'])test(`notification click falls back when ${failure}`,async()=>{
 const sw=serviceWorker([{url:'https://site.example/login?next=/review',navigate:async()=>{if(failure==='navigate throws')throw Error('navigation failed');return failure==='navigate null'?null:{focus:async()=>{throw Error('focus failed');}};}}]);
 await sw.click();assert.deepEqual(sw.opened,[message.url]);
});
test("notification click falls back if an exact review window cannot be focused",async()=>{
 const sw=serviceWorker([{url:message.url,focus:async()=>{throw Error('focus failed');}}]);
 await sw.click();assert.deepEqual(sw.opened,[message.url]);
});
