import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime (Miniflare) with a fresh D1 per run.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { GUIDE_MEASUREMENT_OUTPUT: process.env.PORCHSITE_GUIDE_MEASUREMENT ?? "", TEST_MIGRATIONS: migrations, SETUP_CODE: "test-setup-code" } },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"], testTimeout: 20000 },
  };
});
