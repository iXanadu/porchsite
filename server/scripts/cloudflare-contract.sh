#!/usr/bin/env bash
# Regenerate what the server edition takes from the Cloudflare edition as
# data: server/server/app/field_guide.json (the field guide site_state
# returns) and server/tests/app/cloudflare_tools.json (the tools as the
# Cloudflare edition lists them; tests compare the server edition's to it).
# Run after changing cloudflare/src/models.ts or cloudflare/src/mcp.ts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/contract.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
printf 'export const env = { DB: null };\n' >"$TMP/workers.js"
printf 'export const getMcpAuthContext = () => undefined;\n' >"$TMP/agents.js"
(cd "$ROOT/cloudflare" && NODE_PATH="$ROOT/cloudflare/node_modules" npx esbuild "$ROOT/server/scripts/cloudflare-contract.ts" \
  --bundle --platform=node --format=esm --log-level=error \
  --alias:cloudflare:workers="$TMP/workers.js" --alias:agents/mcp/server="$TMP/agents.js" \
  --outfile="$TMP/contract.mjs")
node "$TMP/contract.mjs" "$ROOT/server/server/app/field_guide.json" "$ROOT/server/tests/app/cloudflare_tools.json"
echo "wrote server/server/app/field_guide.json and server/tests/app/cloudflare_tools.json"
