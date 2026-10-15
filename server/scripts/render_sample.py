#!/usr/bin/env python3
"""render_sample.py THEME SAMPLE.JSON OUTDIR [NOW]: a theme's sample site,
rendered by the server edition's port of the Cloudflare view layer, written
as files exactly as rendered (the same map as `theme.mjs raw`). NOW is an ISO
time (default 2026-10-15T15:30:00Z), so time-dependent pages are stable.
Run with PYTHONPATH=<repo>/server.
"""

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

from server.spec.sample import render_sample, sample_view
from server.spec.sitemap import robots, sitemap
from server.spec.theme import THEMES


def main() -> int:
    if len(sys.argv) not in (4, 5):
        print(__doc__)
        return 2
    name, sample_path, outdir = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    now = datetime.fromisoformat(
        (sys.argv[4] if len(sys.argv) == 5 else "2026-10-15T15:30:00Z").replace("Z", "+00:00")
    )
    sample = json.loads(sample_path.read_bytes().decode("utf-8"))
    root = (
        sample_path.resolve().parent.parent
        if (sample_path.resolve().parent / "template.json").exists()
        else THEMES
    )
    pages = render_sample(name, sample, "https://example.com", now, root)
    v = sample_view(name, sample, now)
    ids = ["site"] + [str(e["id"]) for e in v.entries + v.cards + v.notes]
    v.approved_at = {
        identifier: (now - timedelta(days=i)).isoformat() for i, identifier in enumerate(ids)
    }
    pages["sitemap.xml"] = sitemap(v, "https://example.com")
    pages["robots.txt"] = robots("https://example.com")
    for rel, html in pages.items():
        p = outdir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(html.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
