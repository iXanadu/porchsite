// This wrapper is copied beside the real emitted bundle in a temporary directory.
// It has no public deployment path and returns numeric diagnostics only.
import './clock.mjs';
import application from './application-measured.js';
import {runScoped,registerContext} from './wait-scope.mjs';
import * as native from 'cloudflare:workers';
import * as adapter from './native-workers.mjs';
import { observer, counters, settle } from './observer.mjs';
let state = counters();
const databases = new WeakMap();
export default {
  async fetch(request, env, context) {
    for(const key of Object.keys(native))if(key!=='waitUntil'&&!Object.is(native[key],adapter[key]))throw Error('Native export identity changed');
    state = counters();
    let database = databases.get(env.DB);
    if (!database) {
      // Preserve one binding identity across requests for the UC9 buffer.
      const scope = new Proxy({}, { get: (_, key) => state[key], set: (_, key, value) => { state[key] = value; return true; } });
      database = observer(env.DB, scope); databases.set(env.DB, database);
    }
    const pending = [];
    try {
      const scoped=await runScoped(async()=>{
      const response = await application.fetch(request, { ...env, DB: database }, { ...context, props: context.props, passThroughOnException: context.passThroughOnException.bind(context), waitUntil: value => {pending.push(value);registerContext(value);} });
      const body = new Uint8Array(await response.arrayBuffer());
      await settle(pending);
      return {response,body};});
      const {response,body}=scoped.value;
      if (state.failed) throw Error('Application database work failed');
      state.closed = true;
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map(value => value.toString(16).padStart(2, '0')).join('');
      return Response.json({ status: response.status, headers: [...response.headers], bytes: body.byteLength, body_sha256: digest, counters: state });
    } catch {
      state.closed = true;
      return Response.json({ error: 'Row measurement failed', counters: state }, { status: 500 });
    }
  },
};
