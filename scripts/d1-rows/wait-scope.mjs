import {AsyncLocalStorage} from 'node:async_hooks';
const local=new AsyncLocalStorage();
let busy=false;
function active(){const scope=local.getStore();if(!scope||scope.closed)throw Error('Background work outside open row request');return scope;}
export function registerContext(promise){active().pending.push(promise);}
export function forwardNative(native,promise){const scope=active();scope.pending.push(promise);scope.nativeRegistrations++;return native(promise);}
export async function runScoped(callback){
 if(busy)throw Error('Concurrent row request scopes');busy=true;
 const scope={pending:[],closed:false,nativeRegistrations:0};
 return local.run(scope,async()=>{
  try {const value=await callback();let at=0;while(at<scope.pending.length){const batch=scope.pending.slice(at);at=scope.pending.length;await Promise.all(batch);}return {value,nativeRegistrations:scope.nativeRegistrations};}
  finally{scope.closed=true;busy=false;}
 });
}
