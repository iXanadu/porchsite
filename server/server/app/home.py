"""Where the shared services live: the theme catalog, the downloads and the
request/submission queue. One place, so a move is one line. Port of
cloudflare/src/home.ts."""

import os

HOME = "https://get.porchsite.dev"

# The release this build is, set when the install bundle is made ("dev" otherwise).
RELEASE = os.environ.get("PORCHSITE_RELEASE", "dev")
