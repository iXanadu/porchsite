// Build scripts/theme.ts with the site's own code, then run it.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "sk-theme-")), "theme.cjs");
execFileSync("npx", ["esbuild", "scripts/theme.ts", "--bundle", "--platform=node", `--outfile=${out}`, "--log-level=error"], { stdio: "inherit" });
try {
  execFileSync("node", [out, ...process.argv.slice(2)], { stdio: "inherit" });
} catch (e) {
  process.exit(e.status ?? 1);
}
