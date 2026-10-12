#!/usr/bin/env python3
"""render_sample.py THEME SAMPLE.JSON OUTDIR [NOW]: a theme's sample site,
rendered by the server edition's port of the Cloudflare view layer, written
as files exactly as rendered (the same map as `theme.mjs raw`). NOW is an ISO
time (default 2026-10-15T15:30:00Z), so time-dependent pages are stable.
Run with PYTHONPATH=<repo>/server.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

from server.spec.sample import render_sample
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
    for rel, html in render_sample(name, sample, "https://example.com", now, root).items():
        p = outdir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(html.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
