// Local measurement re-export. Native env and all other exports stay live.
export * from 'cloudflare:workers';
import {waitUntil as nativeWaitUntil} from 'cloudflare:workers';
import {forwardNative} from './wait-scope.mjs';
export function waitUntil(promise){return forwardNative(nativeWaitUntil,promise);}
