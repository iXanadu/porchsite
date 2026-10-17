"""Where a site's themes come from: the built-in ones (the repository's
themes/ folder), ones the assistant installed from the catalog, and looks the
assistant made for this site only. Installs come only from the catalog (a
theme carries scripts, and the catalog's themes are reviewed), checked
against the catalog's sha256. Port of cloudflare/src/themes.ts.

A theme is a dict: {manifest, pages, partials, static} (file name -> text).
"""

from .public_artifacts import public_change

import hashlib
import json
import re
from functools import cache
from pathlib import Path
from typing import Any

from server.spec.jsutil import collate_key, string, trim, u16len
from server.spec.theme import THEMES as THEMES_DIR

from . import themecheck
from .content import site_data
from .db import Db, dumps, now
from .errors import ApiError
from .fetch import Fetcher, fetch
from .home import HOME
from .media import LOCAL, size_of
from .theme import Theme

CATALOG_URL = f"{HOME}/themes.json"
PAGES = ["home", "entry", "archive", "tag", "not_found"]
MAX_BYTES = 1_000_000

# Old names of built-in themes, so sites set before a rename keep their look.
ALIASES = {"classic": "personal-homepage", "broadsheet": "product-page"}

_cache: dict[str, Theme] = {}


def read_theme(d: Path) -> Theme:
    """A theme folder as data (what cloudflare/scripts/themes.mjs bundles)."""

    def read(sub: str, ext: str) -> dict[str, str]:
        folder = d / sub if sub else d
        if not folder.is_dir():
            return {}
        return {
            (f.name[: -len(ext)] if ext else f.name): f.read_bytes().decode("utf-8")
            for f in sorted(folder.iterdir())
            if f.is_file() and (not ext or f.name.endswith(ext))
        }

    return {
        "manifest": json.loads((d / "template.json").read_bytes().decode("utf-8")),
        "pages": read("", ".mustache"),
        "partials": read("partials", ".mustache"),
        "static": read("static", ""),
    }


@cache
def built_in() -> dict[str, Theme]:
    """The themes bundled with this release, by name."""
    return {
        d.name: read_theme(d)
        for d in sorted(THEMES_DIR.iterdir())
        if d.is_dir() and (d / "template.json").exists()
    }


def is_built_in(asked: str) -> bool:
    """A bundled look is available without a database query."""
    return ALIASES.get(asked, asked) in built_in()


async def load(db: Db, asked: str) -> Theme | None:
    """A theme by name: installed first (it may be newer), then built-in."""
    name = ALIASES.get(asked, asked)
    row = await db.fetchrow("SELECT version, package FROM themes WHERE name = $1", name)
    if not row:
        return built_in().get(name)
    key = f"{name}@{row['version']}"
    t = _cache.get(key)
    if t is None:
        t = _cache[key] = json.loads(row["package"])
    return t


async def installed(db: Db) -> list[dict[str, str]]:
    rows = await db.fetch("SELECT name, version, source FROM themes ORDER BY name")
    mine = {r["name"]: r for r in rows}
    out = [
        {
            "name": name,
            "version": str(t["manifest"].get("version")),
            "source": "installed" if name in mine else "built-in",
        }
        for name, t in built_in().items()
    ]
    for o in out:
        if o["name"] in mine:
            o["version"] = mine[o["name"]]["version"]
    for name, r in mine.items():
        if name not in built_in():
            out.append(
                {
                    "name": name,
                    "version": r["version"],
                    "source": "private" if r["source"] == "private" else "installed",
                }
            )
    return sorted(out, key=lambda x: collate_key(x["name"]))


async def catalog(fetcher: Fetcher = fetch) -> list[dict[str, Any]]:
    try:
        r = await fetcher(CATALOG_URL)
    except Exception:
        raise ApiError(
            502, "catalog_unreachable", "The theme catalog didn't answer. Try again in a minute."
        ) from None
    if not r.is_success:
        raise ApiError(
            502,
            "catalog_unreachable",
            f"The theme catalog answered {r.status_code}. Try again in a minute.",
        )
    body = r.json()
    return body.get("themes") or []


def listing(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The catalog as theme_list shows it: no slots or package, the number of
    image slots, and author_x when the look is credited."""
    out = []
    for t in entries:
        rest = {k: v for k, v in t.items() if k not in ("slots", "package", "author")}
        images = ((t.get("slots") or {}).get("images")) or []
        author = t.get("author")
        x = author.get("x") if isinstance(author, dict) else None
        credited = isinstance(x, str) and re.search(r"^[A-Za-z0-9_]{1,15}\Z", x, re.ASCII)
        out.append({**rest, "needs_images": len(images), **({"author_x": x} if credited else {})})
    return out


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check(name: str, t: Any, size: int) -> None:
    """Refuse anything that isn't a whole, well-formed theme."""

    def bad(why: str) -> None:
        raise ApiError(422, "bad_theme", f"The theme package isn't usable: {why}.")

    if size > MAX_BYTES:
        bad("it's larger than 1 MB")
    if not isinstance(t, dict) or any(
        not isinstance(t.get(k), dict) for k in ("manifest", "pages", "partials", "static")
    ):
        bad("it's missing its parts")
    if t["manifest"].get("name") != name:
        bad(f"it says it's {_js(t['manifest'].get('name'))}, not {name}")
    for p in PAGES:
        if not isinstance(t["pages"].get(p), str):
            bad(f"it has no {p} page")
    if not isinstance(t["static"].get("site.css"), str):
        bad("it has no site.css")
    for f in t["static"]:
        if not re.search(r"^[a-z0-9][a-z0-9._-]{0,60}\Z", f):
            bad(f"it has a file named {f}")
    for group in (t["pages"], t["partials"], t["static"]):
        for v in group.values():
            if not isinstance(v, str):
                bad("a file isn't text")


async def install(db: Db, name: str, actor: str, fetcher: Fetcher = fetch) -> dict[str, str]:
    """Install (or update) a theme from the catalog."""
    entry = next((x for x in await catalog(fetcher) if x.get("name") == name), None)
    if not entry:
        raise ApiError(
            404,
            "no_such_theme",
            f"The catalog has no theme called {name}. theme_list shows what it has.",
        )
    try:
        r = await fetcher(entry["package"]["url"])
    except Exception:
        r = None
    if r is None or not r.is_success:
        raise ApiError(
            502,
            "catalog_unreachable",
            "The theme's package didn't download. Try again in a minute.",
        )
    text = r.text
    if _sha256(text) != entry["package"]["sha256"]:
        raise ApiError(
            502,
            "bad_download",
            "The theme's package doesn't match the catalog's checksum, so it wasn't installed.",
        )
    try:
        t = json.loads(text)
    except ValueError:
        raise ApiError(422, "bad_theme", "The theme package isn't usable: it isn't JSON.") from None
    check(name, t, u16len(text))
    mine = await db.fetchrow("SELECT source FROM themes WHERE name = $1", name)
    if mine and mine["source"] == "private":
        raise ApiError(
            409,
            "name_taken",
            f"This site has its own look called {name}; the catalog one can't replace it.",
        )
    version = _js(t["manifest"].get("version"))
    await public_change(db,
        "INSERT INTO themes (name, version, package, sha256, installed_at, installed_by, source)"
        " VALUES ($1, $2, $3, $4, $5, $6, 'catalog')"
        " ON CONFLICT (name) DO UPDATE SET version = excluded.version, package = excluded.package,"
        " sha256 = excluded.sha256, installed_at = excluded.installed_at,"
        " installed_by = excluded.installed_by, source = excluded.source",
        name,
        version,
        text,
        entry["package"]["sha256"],
        now(),
        actor,
    )
    return {"name": name, "version": version}


# --- a look made here, for this site only ------------------------------------------


async def create(
    db: Db, made: dict[str, Any], actor: str, fetcher: Fetcher = fetch
) -> dict[str, str]:
    """Check and store a look the assistant made; nothing else sees it.
    made: {manifest, sample, pages, partials?, css}."""
    manifest = made.get("manifest") or {}
    name = string(manifest.get("name")) if isinstance(manifest, dict) else ""
    if not re.search(r"^[a-z][a-z0-9-]{0,39}\Z", name):
        raise ApiError(422, "bad_theme", "manifest.name: lowercase letters, digits and dashes.")
    if name in built_in() or name in ALIASES:
        raise ApiError(409, "name_taken", f"{name} is a built-in theme's name; pick another.")
    try:
        listed = await catalog(fetcher)
    except Exception:
        listed = []
    if any(x.get("name") == name for x in listed):
        raise ApiError(409, "name_taken", f"The catalog has a theme called {name}; pick another.")
    have = await db.fetchrow("SELECT source FROM themes WHERE name = $1", name)
    if have and have["source"] != "private":
        raise ApiError(
            409, "name_taken", f"This site has a catalog theme called {name}; pick another."
        )
    t: Theme = {
        "manifest": manifest,
        "pages": made.get("pages") or {},
        "partials": made.get("partials") or {},
        "static": {"site.css": made.get("css") or ""},
    }
    package = {**t}
    if "sample" in made:
        package["sample"] = made["sample"]
    text = dumps(package)
    if u16len(text) > MAX_BYTES:
        raise ApiError(422, "bad_theme", "The look is larger than 1 MB.")
    problems = themecheck.check(name, t, made.get("sample"), scripts=False)
    if problems:
        raise ApiError(422, "theme_problems", f"The look isn't usable yet: {'; '.join(problems)}")
    version = _js(manifest.get("version"))
    await public_change(db,
        "INSERT INTO themes (name, version, package, sha256, installed_at, installed_by, source)"
        " VALUES ($1, $2, $3, $4, $5, $6, 'private')"
        " ON CONFLICT (name) DO UPDATE SET version = excluded.version, package = excluded.package,"
        " sha256 = excluded.sha256, installed_at = excluded.installed_at,"
        " installed_by = excluded.installed_by, source = excluded.source",
        name,
        version,
        text,
        _sha256(text),
        now(),
        actor,
    )
    _cache.clear()
    return {"name": name, "version": version}


# --- what a theme needs from this site --------------------------------------------


def _js(v: Any) -> str:
    """String(v) for a value that may be missing."""
    return "undefined" if v is None else string(v)


def _split2(v: Any) -> tuple[str, str | None]:
    """const [kind, field] = String(v).split(".")"""
    parts = string(v).split(".")
    return parts[0], parts[1] if len(parts) > 1 else None


def _shape_of(size: tuple[int, int]) -> str:
    return "square" if size[0] == size[1] else "wide" if size[0] > size[1] else "tall"


async def needs(db: Db, t: Theme) -> dict[str, Any]:
    """Each slot the theme declares, marked against the site as it stands now
    (unapproved changes included)."""
    site = await site_data(db, False)
    slots = t["manifest"].get("slots") or {}
    images = []
    for s in slots.get("images") or []:
        out = dict(s)
        kind, field = _split2(s.get("field"))
        if kind != "site":
            out["status"] = "per item: check each one"
        else:
            v = string(site.get(field)) if field is not None else ""
            if not v:
                out["status"] = "empty (optional)" if s.get("need") == "optional" else "missing"
            else:
                m = LOCAL.search(v)
                got = await size_of(db, m.group(1)) if m else (0, 0)
                out["has"] = {"image": v, "width": got[0], "height": got[1]}
                w, h = s["size"]
                ratio_ok = (
                    got[0] > 0 and got[1] > 0 and abs(got[0] / got[1] - w / h) <= 0.02 * (w / h)
                )
                big_enough = got[0] >= w and got[1] >= h
                if not got[0]:
                    out["status"] = "filled (size unknown)"
                elif not ratio_ok:
                    out["status"] = (
                        f"wrong shape: it's {got[0]}x{got[1]} ({_shape_of(got)}), needs {w}x{h}"
                    )
                elif not big_enough:
                    out["status"] = f"too small: it's {got[0]}x{got[1]}, needs at least {w}x{h}"
                else:
                    out["status"] = "filled"
                if s.get("alt") and not site.get(_split2(s["alt"])[1]):
                    out["status"] += "; its description is missing"
        images.append(out)
    content = []
    for s in slots.get("content") or []:
        kind, field = _split2(s.get("field"))
        if kind != "site":
            content.append({**s, "status": "see purpose"})
            continue
        v = site.get(field)
        filled = len(v) > 0 if isinstance(v, list) else bool(trim(string(v)))
        content.append(
            {
                **s,
                "status": "filled"
                if filled
                else "empty (optional)"
                if s.get("need") == "optional"
                else "missing",
            }
        )
    # Empty, the wrong shape or too small: each named in to_fix.
    to_fix = [
        x
        for x in [*images, *content]
        if re.search(r"^missing|wrong shape|too small", str(x["status"]))
    ]
    missing = len(to_fix)
    palettes = [
        {"name": name, "title": p.get("title"), "default": i == 0}
        for i, (name, p) in enumerate((t["manifest"].get("palettes") or {}).items())
    ]
    chosen = string(site.get("palette"))
    return {
        "theme": t["manifest"].get("name"),
        "version": t["manifest"].get("version"),
        "type": t["manifest"].get("type") or "",
        "palettes": palettes,
        "palette": chosen
        if any(p["name"] == chosen for p in palettes)
        else (palettes[0]["name"] if palettes else ""),
        "art": t["manifest"].get("art"),
        "images": images,
        "content": content,
        "missing": missing,
        "to_fix": [f"{x['field']}: {x['status']}" for x in to_fix],
    }
