// Collect fresh JSON answers from the local Workers test runtime.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const [output, ...looks] = process.argv.slice(2);
if (!output || !looks.length) throw new Error("usage: tool-parity.mjs OUTDIR LOOK...");
mkdirSync(output, { recursive: true });
const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.parity.config.ts", "--update"], {
  encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, PORCHSITE_PARITY_LOOKS: JSON.stringify(looks), PORCHSITE_PARITY_OUTPUT: resolve(output), VITEST_MAX_WORKERS: "1" },
});
if (run.status !== 0) {
  process.stderr.write((run.stdout ?? "") + (run.stderr ?? ""));
  process.exit(1);
}
const count = readdirSync(output).filter(name => name.endsWith(".json")).length;
const regressions = JSON.parse(readFileSync("../spec/tool-parity-cases.json", "utf8")).length;
if (count !== looks.length + regressions) throw new Error(`missing tool output: got ${count}, expected ${looks.length + regressions}`);
console.log(`Cloudflare tool parity: ${looks.length} samples and ${regressions} regression fixtures`);
