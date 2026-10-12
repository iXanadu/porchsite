#!/bin/sh
# Build the install bundle an assistant uploads through the Cloudflare API
# (INSTALL.md): one Worker module plus the schema as plain SQL files.
set -eu
cd "$(dirname "$0")/.."
rm -rf dist
node scripts/themes.mjs >/dev/null
RELEASE="${RELEASE:-$(date -u +%Y.%m.%d)-$(git rev-parse --short HEAD)}"
npx wrangler deploy --dry-run --minify --define "__RELEASE__:\"$RELEASE\"" --outdir dist/build >/dev/null
mkdir -p dist/migrations
cp dist/build/index.js dist/sitekeeper.js
cp migrations/*.sql dist/migrations/
rm -rf dist/build
ls -l dist dist/migrations
