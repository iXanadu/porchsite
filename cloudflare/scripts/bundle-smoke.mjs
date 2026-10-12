// Run a released bundle (sitekeeper.js, as an owner uploads it) locally (wrangler dev)
// on a database built from a migrations folder, and check that it serves.
// scripts/upgrade-check.sh runs the PREVIOUS release's archived bundle on
// the NEW migrations: a rollback is a re-upload of that bundle with no
// schema step, so it must work there.
//
//   node scripts/bundle-smoke.mjs <sitekeeper.js> <migrations dir> <release id>
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [bundle, migrations, release] = process.argv.slice(2);
if (!bundle || !migrations) {
  console.error("usage: bundle-smoke.mjs <sitekeeper.js> <migrations dir> [release id]");
  process.exit(2);
}

// A throwaway Worker project around the bundle, as an owner's upload has it:
// the bundle as-is (no build), D1 with the migrations applied, KV, the secret.
// The state and the migrations live outside the Worker's folder: wrangler
// dev watches that folder and would reload on every database write.
const dir = mkdtempSync(path.join(os.tmpdir(), "porchsite-smoke-"));
mkdirSync(path.join(dir, "migrations"));
mkdirSync(path.join(dir, "worker"));
copyFileSync(bundle, path.join(dir, "worker", "sitekeeper.js"));
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) copyFileSync(path.join(migrations, f), path.join(dir, "migrations", f));
const config = path.join(dir, "worker", "wrangler.jsonc");
writeFileSync(
  config,
  JSON.stringify({
    name: "porchsite-smoke",
    main: "sitekeeper.js",
    no_bundle: true,
    compatibility_date: "2026-08-15",
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    d1_databases: [{ binding: "DB", database_name: "smoke", database_id: "00000000-0000-4000-8000-000000000000", migrations_dir: "../migrations" }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: "smoke" }],
    vars: { SETUP_CODE: "smoke-setup-code-0123456789" },
  }),
);
const wrangler = path.resolve("node_modules/.bin/wrangler");
const persist = path.join(dir, "state");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
const applied = spawnSync(wrangler, ["d1", "migrations", "apply", "smoke", "--local", "--config", config, "--persist-to", persist], { env, encoding: "utf8" });
if (applied.status !== 0) {
  console.error(`bundle-smoke: the migrations failed to apply\n${applied.stdout}\n${applied.stderr}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const dev = spawn(wrangler, ["dev", "--config", config, "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false"], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
dev.stdout.on("data", (d) => (log += d));
dev.stderr.on("data", (d) => (log += d));
const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    await fetch(`${base}/robots.txt`, { signal: AbortSignal.timeout(3000) });
    up = true;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
const stop = () => {
  dev.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
};
if (!up) {
  stop();
  console.error(`bundle-smoke: the bundle didn't start\n${log.slice(-2000)}`);
  process.exit(1);
}
const failures = [];
try {
  const get = (p, init) => fetch(`${base}${p}`, { redirect: "manual", signal: AbortSignal.timeout(15000), ...init });
  const expect = async (label, p, ok, init) => {
    const r = await get(p, init);
    const body = await r.text();
    const why = ok(r, body);
    if (why) failures.push(`${label}: ${why} (HTTP ${r.status})`);
    // Releases before 2026.10.10-bd677cc don't send the header.
    const said = r.headers.get("X-Porchsite-Release");
    if (release && said !== null && said !== release) {
      failures.push(`${label}: X-Porchsite-Release is ${said}, expected ${release}`);
    }
    return r;
  };
  await expect("home", "/", (r, b) => (r.status === 200 && b.includes("<html") ? "" : "no page"));
  // Unclaimed, the owner's pages send to /setup (claimed: to /login).
  await expect("review (signed out)", "/review", (r) => ([302, 303].includes(r.status) && /\/(login|setup)/.test(r.headers.get("Location") ?? "") ? "" : "doesn't send to sign-in"));
  await expect("login", "/login", (r) => (r.status === 200 || [302, 303].includes(r.status) ? "" : "no sign-in page"));
  await expect("setup (unclaimed)", "/setup", (r) => (r.status === 200 ? "" : "no setup page"));
  await expect("oauth metadata", "/.well-known/oauth-authorization-server", (r, b) => (r.status === 200 && b.includes("authorization_endpoint") ? "" : "no metadata"));
  await expect(
    "mcp (no token)",
    "/mcp",
    (r) => (r.status === 401 ? "" : "expected 401"),
    { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
  );
  await expect("feed", "/feed.xml", (r) => (r.status === 200 || r.status === 404 ? "" : "server error"));
  console.log(`bundle-smoke: ${files.length} migrations applied; ${failures.length ? "FAILED" : "ok"} (${release ?? path.basename(bundle)})`);
} finally {
  stop();
}
for (const f of failures) console.error(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
