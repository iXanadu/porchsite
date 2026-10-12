"""A theme's sample site rendered page by page (port of renderSample and
sampleView in cloudflare/src/themecheck.ts)."""

from datetime import datetime
from pathlib import Path
from typing import Any

from . import site as site_mod
from . import theme
from .models import parse


def sample_view(
    name: str, sample: dict[str, Any], now: datetime | None = None
) -> site_mod.SiteView:
    """A sample site's view, as the site itself would build it."""
    s = parse("site", {**sample["site"], "theme": name})
    rows = [
        {
            "id": f"i{i}",
            "kind": it["kind"],
            "slug": it["slug"] if it.get("slug") is not None else f"item-{i}",
            "data": parse(it["kind"], it["data"]),
        }
        for i, it in enumerate(sample["items"])
    ]
    v = site_mod.view(s, rows)
    v.updated = "Oct 10, 9:00 AM CT"
    if now:
        v.now = now
    return v


def render_sample(
    name: str,
    sample: dict[str, Any],
    origin: str = "https://example.com",
    now: datetime | None = None,
    root: Path = theme.THEMES,
) -> dict[str, str]:
    """Every page of a sample site: home, each entry, each stream's archive and tag pages, the 404."""
    v = sample_view(name, sample, now)
    out = {"index.html": theme.render(name, "home", theme.home_view(v, "1", origin), root)}
    for e in v.entries:
        if not e.get("external_url"):
            out[f"{e['page'][1:]}index.html"] = theme.render(
                name, "entry", theme.entry_view(v, e, "1", origin), root
            )
    for st in theme.streams(v.site):
        path = _strip_slashes(st["archive_url"])
        av = theme.archive_view(v, path, "1", origin)
        if av:
            out[f"{path}/index.html"] = theme.render(name, "archive", av, root)
        tags = dict.fromkeys(
            t for e in v.entries if e["stream"] == st["id"] for t in (e.get("tags") or [])
        )
        for tag in tags:
            out[f"{path}/tags/{tag}/index.html"] = theme.render(
                name, "tag", theme.archive_view(v, path, "1", origin, tag), root
            )
    out["404.html"] = theme.render(name, "not_found", theme.not_found_view(v, "1", origin), root)
    return out


def _strip_slashes(p: str) -> str:
    """.replace(/^\\/|\\/$/g, "")"""
    if p.startswith("/"):
        p = p[1:]
    if p.endswith("/"):
        p = p[:-1]
    return p
