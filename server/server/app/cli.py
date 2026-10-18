"""The server edition's admin commands.

    python -m server.app.cli setup-link [--hours 24] [--origin https://example.com]
    python -m server.app.cli setup-code
    python -m server.app.cli token --name <assistant> [--origin https://example.com] [--ttl 3600]
    python -m server.app.cli check

In the container setup, run them in the app container:
`docker compose exec app python -m server.app.cli <command>`.

`setup-link` makes a fresh one-time setup code, stores it in the database
(hashed) for --hours (default 24), and prints the link to send the owner:
https://<site>/setup#code=<code>. The owner opens it and saves a passkey; no
env edit or restart. A new link replaces any earlier one. Once the site is
claimed it refuses (exit 1): add a device with a passkey link from the
owner's page instead. The site's address is --origin, else
PORCHSITE_SITE_URL; the database is PORCHSITE_DSN. The link is printed on
stdout, nothing else; when it expires goes to stderr.

`setup-code` prints a fresh, strong setup code (for PORCHSITE_SETUP_CODE, which
still works). It touches nothing.

`token` mints an access token for a named assistant without the browser
dance, for tests and the conformance check. It is bound to the site's address
(--origin, else PORCHSITE_SITE_URL) and shows on /review/assistants like any
connected assistant, where the owner can disconnect it. The database is
PORCHSITE_DSN. The token is printed on stdout, nothing else.

`check` says whether this install is sound: the database answers, its schema
is current, the looks are found, the settings make sense. It changes nothing
(a schema that is behind is brought up to date by the app's next start).
Exits 1 if anything is wrong, 0 otherwise (warnings included).
"""

import argparse
import asyncio
import os
import secrets
import sys
from urllib.parse import urlsplit

import asyncpg

from . import oauth, owner
from .db import MIGRATIONS, connect, now
from .errors import ApiError
from .settings import Settings

# No 0/o, 1/l/i: easy to read aloud and to type from a phone.
_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def setup_code() -> str:
    """Five groups of five: about 124 bits."""
    return "-".join("".join(secrets.choice(_ALPHABET) for _ in range(5)) for _ in range(5))


async def _token(dsn: str, name: str, origin: str, ttl: int) -> str:
    pool = await connect(dsn, min_size=1, max_size=2)
    try:
        return await oauth.mint(pool, name, origin, ttl)
    finally:
        await pool.close()


CLAIMED = "already claimed; use a passkey link from the owner's page to add a device"


async def setup_link(dsn: str, origin: str, hours: float) -> tuple[str, str]:
    """(link, expires_at). Raises ApiError "claimed" once the site has an owner."""
    pool = await connect(dsn, min_size=1, max_size=2)
    try:
        code = setup_code()
        expires_at = await owner.issue_setup_code(pool, code, hours)
    finally:
        await pool.close()
    return f"{origin}/setup#code={code}", expires_at


async def recovery_link(dsn: str,origin: str,hours: float) -> tuple[str,str]:
    pool = await connect(dsn,min_size=1,max_size=2)
    try:
        code = owner.b64url(secrets.token_bytes(24))
        expires = await owner.issue_recovery_code(pool,code,hours)
    finally:
        await pool.close()
    return f"{origin}/recover?code={code}",expires


async def check(settings: Settings) -> list[tuple[str, str]]:
    """(level, message) pairs; level is "ok", "warn" or "fail"."""
    out: list[tuple[str, str]] = []

    def say(level: str, message: str) -> None:
        out.append((level, message))

    # The database.
    claimed: bool | None = None
    link_until: str | None = None
    if not settings.dsn:
        say("fail", "PORCHSITE_DSN is not set")
    else:
        try:
            conn = await asyncpg.connect(settings.dsn, timeout=10)
        except Exception as e:
            say("fail", f"database unreachable: {type(e).__name__}: {e}")
        else:
            try:
                say(
                    "ok",
                    "database reachable (PostgreSQL "
                    + await conn.fetchval("SHOW server_version")
                    + ")",
                )
                has_table = await conn.fetchval(
                    "SELECT to_regclass('schema_migrations') IS NOT NULL"
                )
                done = (
                    {r["name"] for r in await conn.fetch("SELECT name FROM schema_migrations")}
                    if has_table
                    else set()
                )
                pending = [n for n, _ in MIGRATIONS if n not in done]
                latest = MIGRATIONS[-1][0]
                if not has_table:
                    say("warn", "schema not applied yet: the app applies it when it starts")
                elif pending:
                    say(
                        "warn",
                        f"schema behind ({', '.join(pending)} pending): "
                        "the app applies it when it next starts",
                    )
                else:
                    say("ok", f"schema current ({latest})")
                newer = sorted(done - {n for n, _ in MIGRATIONS})
                if newer:
                    # Migrations only add, so an older release runs on a newer schema.
                    say(
                        "ok",
                        f"schema also has {', '.join(newer)} from a newer release (rolled back; fine)",
                    )
                if has_table:
                    claimed = bool(await conn.fetchval("SELECT count(*) FROM owner"))
                if await conn.fetchval("SELECT to_regclass('setup_codes') IS NOT NULL"):
                    link_until = await conn.fetchval(
                        "SELECT max(expires_at) FROM setup_codes WHERE expires_at > $1", now()
                    )
            finally:
                await conn.close()

    # The looks.
    from server.spec.theme import THEMES

    if not THEMES.is_dir():
        say("fail", f"themes folder not found at {THEMES} (set PORCHSITE_THEMES)")
    else:
        names = sorted(
            d.name for d in THEMES.iterdir() if d.is_dir() and (d / "template.json").exists()
        )
        if names:
            say("ok", f"{len(names)} looks found in {THEMES}")
        else:
            say("fail", f"no looks in {THEMES} (each needs a template.json)")

    # The setup code.
    code = settings.setup_code
    if claimed:
        say("ok", "site claimed by its owner")
        if code:
            say("warn", "PORCHSITE_SETUP_CODE is still set: remove it now the site is claimed")
    else:
        if code and len(code) < 8:
            say("fail", "PORCHSITE_SETUP_CODE is shorter than 8 characters: the site refuses it")
        elif code and len(code) < 20:
            say("warn", "PORCHSITE_SETUP_CODE is short: make a strong one with `setup-code`")
        elif code:
            say("ok", "setup code set: open /setup to claim the site")
        if link_until:
            say("ok", f"a setup link works until {link_until}")
        elif not code:
            say(
                "warn",
                "no setup code yet: run `setup-link` and send the owner the link it prints",
            )

    # The site's address.
    url = settings.site_url
    if not url:
        say(
            "warn",
            "PORCHSITE_SITE_URL is not set: tokens bind to whatever address a request came in on",
        )
    else:
        p = urlsplit(url)
        local = p.hostname in ("localhost", "127.0.0.1", "::1")
        if p.scheme not in ("https", "http") or not p.hostname:
            say("fail", f"PORCHSITE_SITE_URL is not an address: {url}")
        elif p.path not in ("", "/") or p.query or p.fragment:
            say("fail", f"PORCHSITE_SITE_URL must be the bare address, no path: {url}")
        elif p.scheme == "http" and not local:
            say("fail", "PORCHSITE_SITE_URL must be https (passkeys work only over HTTPS)")
        elif (p.hostname or "").startswith("www."):
            say("fail", "PORCHSITE_SITE_URL must be the bare domain: www. redirects to it")
        else:
            say("ok", f"site address {url}")

    if settings.release == "dev":
        say("warn", 'PORCHSITE_RELEASE is not set: answers say release "dev"')
    else:
        say("ok", f"release {settings.release}")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m server.app.cli", description=__doc__.split("\n\n")[0]
    )
    sub = ap.add_subparsers(dest="command", required=True)
    link = sub.add_parser(
        "setup-link", help="print a one-time link the owner opens to claim the site"
    )
    link.add_argument(
        "--hours", type=float, default=owner.SETUP_HOURS, help="hours it works (default 24)"
    )
    link.add_argument(
        "--origin", default=os.environ.get("PORCHSITE_SITE_URL", ""), help="the site's address"
    )
    recovery = sub.add_parser("recovery-link",help="issue a hosting-account recovery link; replaces all owner passkeys when used")
    recovery.add_argument("--hours",type=float,default=24)
    recovery.add_argument("--origin",default=os.environ.get("PORCHSITE_SITE_URL",""))
    sub.add_parser("setup-code", help="print a fresh, strong setup code")
    tok = sub.add_parser("token", help="mint an assistant's access token")
    tok.add_argument("--name", required=True, help="the assistant's name, shown on its requests")
    tok.add_argument(
        "--origin", default=os.environ.get("PORCHSITE_SITE_URL", ""), help="the site's address"
    )
    tok.add_argument(
        "--ttl", type=int, default=oauth.ACCESS_TTL, help="seconds it works (default 3600)"
    )
    sub.add_parser("check", help="check the database, schema, looks and settings")
    args = ap.parse_args(argv)

    if args.command == "setup-code":
        print(setup_code())
        return 0
    if args.command == "check":
        results = asyncio.run(check(Settings.from_env()))
        marks = {"ok": "ok  ", "warn": "warn", "fail": "FAIL"}
        for level, message in results:
            print(f"{marks[level]}  {message}")
        return 1 if any(level == "fail" for level, _ in results) else 0

    dsn = os.environ.get("PORCHSITE_DSN", "")
    if not dsn:
        ap.error("PORCHSITE_DSN is not set")
    if args.command in ("setup-link","recovery-link"):
        p = urlsplit(args.origin.strip())
        if p.scheme not in ("https", "http") or not p.hostname:
            ap.error("give the site's address with --origin (or set PORCHSITE_SITE_URL)")
        origin = f"{p.scheme}://{p.netloc}"
        if not 0 < args.hours <= 24 * 30:
            ap.error("--hours must be more than 0 and at most 720")
        try:
            url, expires_at = asyncio.run((setup_link if args.command == "setup-link" else recovery_link)(dsn, origin, args.hours))
        except ApiError as e:
            if e.code != "claimed":
                raise
            print(CLAIMED, file=sys.stderr)
            return 1
        print(url)
        print(f"works once, until {expires_at}; a new link replaces this one", file=sys.stderr)
        return 0
    origin = args.origin.rstrip("/")
    if not origin.startswith(("https://", "http://")):
        ap.error("give the site's address with --origin (or set PORCHSITE_SITE_URL)")
    print(asyncio.run(_token(dsn, args.name.strip()[:80], origin, args.ttl)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
