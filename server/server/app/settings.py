"""The server edition's settings, from the environment. The Cloudflare edition
reads the same things from its Worker bindings (SETUP_CODE, SITE_URL) and its
build (RELEASE).

  PORCHSITE_DSN         the PostgreSQL database
  PORCHSITE_SETUP_CODE  optional: a code that lets the owner claim a fresh site
                        (else `cli setup-link` issues one-time codes, stored
                        in the database)
  PORCHSITE_SITE_URL    the site's address (optional; else the address a
                        request came in on). Assistants' tokens are bound to it.
  PORCHSITE_PUBLIC_ARTIFACTS  opt in to prepared public copies only when exactly 1
  PORCHSITE_RELEASE     the release this is, sent on every answer (default "dev")
"""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    dsn: str = ""
    setup_code: str = ""
    site_url: str = ""
    release: str = "dev"
    public_artifacts: bool = False

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            dsn=os.environ.get("PORCHSITE_DSN", ""),
            setup_code=os.environ.get("PORCHSITE_SETUP_CODE", ""),
            site_url=os.environ.get("PORCHSITE_SITE_URL", "").rstrip("/"),
            release=os.environ.get("PORCHSITE_RELEASE", "") or "dev",
            public_artifacts=os.environ.get("PORCHSITE_PUBLIC_ARTIFACTS", "")=="1",
        )
