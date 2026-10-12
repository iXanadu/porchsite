/**
 * The site kit's analytics beacon, served at /static/a.js on every site
 * (SPEC §8). The server edition serves the same bytes
 * (server/server/app/beacon.js; a test there compares the two).
 */
export const BEACON_JS = String.raw`// Visitor analytics beacon, part of the site kit. First-party, no cookies,
// nothing sent anywhere but this site's /collect (SPEC section 8).
// Opt out on a device: visit any page with ?sk_notrack=1 (undo: =0).
(function () {
  var q = new URLSearchParams(location.search);
  var store = {};
  try { store = window.localStorage || {}; } catch (e) {}
  var flag = q.get("sk_notrack");
  try {
    if (flag === "1") store.setItem("sk_notrack", "1");
    if (flag === "0") store.removeItem("sk_notrack");
  } catch (e) {}
  var test = q.get("sk_verify") === "1";
  try {
    if (test) sessionStorage.setItem("sk_verify", "1");
    test = test || sessionStorage.getItem("sk_verify") === "1";
  } catch (e) {}
  test = test || navigator.webdriver === true;

  // Tagged links (?src=x&p=<post>): read them, then take them out of the
  // address bar so a reader who shares the page doesn't pass them on.
  var src = q.get("src") || "", post = q.get("p") || "";
  var tagged = ["src", "p", "sk_notrack", "sk_verify"].filter(function (k) { return q.has(k); });
  tagged.forEach(function (k) { q.delete(k); });
  if (tagged.length) {
    try {
      var rest = q.toString();
      history.replaceState(history.state, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    } catch (e) {}
  }

  var off = false;
  try { off = store.getItem && store.getItem("sk_notrack") === "1"; } catch (e) {}
  if (off || !navigator.sendBeacon || location.pathname.indexOf("/review") === 0) return;

  var id = Array.prototype.map.call(
    (window.crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(12)) : [],
    function (b) { return ("0" + b.toString(16)).slice(-2); }
  ).join("") || (Date.now().toString(36) + Math.random().toString(36).slice(2));

  function send(ev) {
    ev.id = id;
    navigator.sendBeacon("/collect", new Blob([JSON.stringify(ev)], { type: "text/plain" }));
  }

  var b = document.body.dataset;
  send({ t: "pv", p: location.pathname, k: b.kind || "other", c: b.id || "",
         r: document.referrer, s: src, q: post, w: test ? 1 : 0 });

  // Engaged time: counts only while the tab is visible and the reader did
  // something in the last 30 seconds.
  var engaged = 0, lastInput = Date.now(), lastTick = Date.now(), sent = "", depth = 0;
  function input() { lastInput = Date.now(); }
  ["scroll", "pointerdown", "pointermove", "keydown", "touchstart", "wheel"].forEach(function (t) {
    addEventListener(t, input, { passive: true });
  });
  function tick() {
    var now = Date.now();
    if (document.visibilityState === "visible" && now - lastInput < 30000) {
      engaged += Math.min(now - lastTick, 5000);
    }
    lastTick = now;
  }

  // Scroll depth through the article body (the whole page where there isn't one).
  var body = document.querySelector(".entry-body") || document.querySelector("main");
  function measure() {
    if (!body) return;
    var r = body.getBoundingClientRect();
    var seen = r.height > 0 ? (innerHeight - r.top) / r.height : 1;
    var pct = seen >= 1 ? 100 : seen >= 0.75 ? 75 : seen >= 0.5 ? 50 : seen >= 0.25 ? 25 : 0;
    if (pct > depth) depth = pct;
  }
  addEventListener("scroll", measure, { passive: true });
  measure();

  function beat() {
    tick();
    var now = engaged + ":" + depth;
    if (now !== sent) { sent = now; send({ t: "hb", e: engaged, d: depth }); }
  }
  setInterval(tick, 1000);
  setInterval(function () { if (document.visibilityState === "visible") beat(); }, 15000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") beat(); else { lastTick = Date.now(); input(); }
  });
  addEventListener("pagehide", beat);
})();
`;
