/** Native review projection parity; output is external test evidence only. */
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          SETUP_CODE: "test-setup-code",
          OWNER_REVIEW_PARITY_OUTPUT: process.env.OWNER_REVIEW_PARITY_OUTPUT ?? "",
        },
      },
    }),
  ],
  test: {
    include: ["test/owner-review.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    testTimeout: 20000,
  },
}));
