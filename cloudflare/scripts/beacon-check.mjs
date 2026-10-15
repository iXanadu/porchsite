// Execute the shipped browser script with a deterministic clock and lifecycle.
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

const ts = readFileSync(new URL("../src/beacon.ts", import.meta.url), "utf8");
const cf = ts.slice(ts.indexOf("String.raw`") + 11, ts.lastIndexOf("`"));
const server = readFileSync(new URL("../../server/server/app/beacon.js", import.meta.url), "utf8");
test("both editions ship identical beacon bytes", () => assert.equal(cf, server));

function browser(source, active = true) {
  let now = 0, serial = 0;
  const timers = new Map(), pending = [], handlers = {}, docHandlers = {};
  function schedule(fn, delay, repeat = false) {
    const id = ++serial;
    timers.set(id, { fn, delay, repeat, due: now + delay });
    return id;
  }
  const document = {
    body: { dataset: { kind: "entry", id: "ent_aaaa1111" } }, referrer: "",
    visibilityState: "visible",
    querySelector: () => ({ getBoundingClientRect: () => ({ height: 1000, top: 0 }) }),
    addEventListener: (name, fn) => { docHandlers[name] = fn; },
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  vm.runInNewContext(source, {
    URLSearchParams, Uint8Array, Blob, Math, crypto: webcrypto,
    Date: { now: () => now }, innerHeight: 800,
    window: { localStorage: storage, crypto: webcrypto }, sessionStorage: storage,
    location: { search: "", pathname: "/journal/entry/", hash: "" },
    document, history: { replaceState() {} },
    navigator: { webdriver: false, sendBeacon: (url, body) => {
      assert.equal(url, "/collect");
      const at = now;
      pending.push(body.text().then(text => ({ at, ...JSON.parse(text) })));
      return true;
    } },
    addEventListener: (name, fn) => { (handlers[name] ||= []).push(fn); },
    setInterval: (fn, delay) => schedule(fn, delay, true),
    setTimeout: (fn, delay) => schedule(fn, delay),
  });
  function fire(name) { for (const fn of handlers[name] || []) fn(); }
  if (active) schedule(() => fire("pointerdown"), 10000, true);
  return {
    advance(target, inclusive = true) {
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next || (inclusive ? next[1].due > target : next[1].due >= target)) break;
        const [id, timer] = next;
        now = timer.due;
        if (timer.repeat) timer.due += timer.delay; else timers.delete(id);
        timer.fn();
      }
      now = target;
    },
    hide() { document.visibilityState = "hidden"; docHandlers.visibilitychange(); },
    show() { document.visibilityState = "visible"; docHandlers.visibilitychange(); },
    fire,
    events: () => Promise.all(pending),
  };
}

for (const [edition, source] of [["Cloudflare", cf], ["server", server]]) {
  test(`${edition}: exact active visits flush cumulative progress and dedupe final events`, async () => {
    for (const [seconds, count] of [[5, 1], [30, 1], [60, 2], [300, 6]]) {
      for (const timerFirst of [false, true]) {
        const b = browser(source);
        b.advance(seconds * 1000, timerFirst);
        // pagehide also occurs without visibilitychange (including BFCache).
        b.fire("pagehide"); b.hide(); b.fire("pagehide");
        b.advance(seconds * 1000);
        const events = await b.events(), beats = events.filter(e => e.t === "hb");
        assert.equal(events.filter(e => e.t === "pv").length, 1);
        assert.equal(beats.length, count, `${seconds}s, timerFirst=${timerFirst}`);
        assert.equal(beats.at(-1).e, seconds * 1000);
        assert.equal(beats.at(-1).d, 75);
      }
    }
  });
  test(`${edition}: idle, hide/resume and BFCache do not invent views or hidden engagement`, async () => {
    const idle = browser(source, false);
    idle.advance(300000); idle.fire("pagehide");
    const idleEvents = await idle.events();
    assert.equal(idleEvents.filter(e => e.t === "hb").length, 1);
    assert.equal(idleEvents.at(-1).e, 29000);
    const b = browser(source);
    b.advance(10000); b.hide(); b.fire("pagehide");
    b.advance(120000); b.show(); b.fire("pageshow");
    b.advance(130000); b.fire("pagehide"); b.hide();
    const events = await b.events();
    assert.equal(events.filter(e => e.t === "pv").length, 1);
    assert.deepEqual(events.filter(e => e.t === "hb").map(e => e.e), [10000, 20000]);
  });
  test(`${edition}: a missing final message leaves the last measured snapshot, not an estimate`, async () => {
    const b = browser(source);
    b.advance(60000);
    const events = await b.events();
    assert.deepEqual(events.filter(e => e.t === "hb").map(e => e.e), [30000]);
    b.fire("pagehide");
    assert.equal((await b.events()).at(-1).e, 60000);
  });
}
