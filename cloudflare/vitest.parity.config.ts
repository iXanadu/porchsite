// A separate local-only runtime for comparing real tool answers with the
// server edition. No developer account or external service is used.
import { readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  if (!process.env.PORCHSITE_PARITY_OUTPUT) throw new Error("Run through node scripts/tool-parity.mjs OUTDIR LOOK...");
  const names: string[] = JSON.parse(process.env.PORCHSITE_PARITY_LOOKS ?? "[]");
  const cases = names.map(name => ({ name, theme: name, sample: JSON.parse(readFileSync(`../themes/${name}/sample.json`, "utf8")) }));
  cases.push(...JSON.parse(readFileSync("../spec/tool-parity-cases.json", "utf8")));
  return {
    plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: {
      TEST_MIGRATIONS: await readD1Migrations("./migrations"),
      PARITY_CASES: JSON.stringify(cases),
      PARITY_NOW: process.env.NOW ?? "2026-10-15T15:30:00Z",
      PARITY_OUTPUT: process.env.PORCHSITE_PARITY_OUTPUT ?? "",
    } } })],
    test: { include: ["scripts/tool-parity.worker.ts"], setupFiles: ["./test/apply-migrations.ts"], maxWorkers: 1, testTimeout: 60000 },
  };
});
