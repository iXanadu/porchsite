"""Render the paired expanded-stream fixture for scripts/parity.sh."""

import json
import sys
from datetime import datetime
from urllib.parse import parse_qsl

from server.app.builtin import all_archive_page
from server.app.theme import feed, search_index
from server.spec.archive import archive_filter
from server.spec.sample import render_sample, sample_view
from server.spec.sitemap import sitemap
from server.spec.theme import THEMES

fixture, output = sys.argv[1:]
sample = json.loads(open(fixture).read())
out, origin = {}, "https://example.com"
now = datetime.fromisoformat("2026-10-15T15:30:00+00:00")
for folder in sorted(THEMES.iterdir()):
    if not (folder / "sample.json").is_file():
        continue
    name = folder.name
    v = sample_view(name, sample, now)
    out[name] = render_sample(name, sample, origin, now)
    for query in (
        "",
        "sort=stream",
        "tag=report",
        "stream=part-8",
        "tag=report&stream=part-8",
        "tag=missing",
        "stream=missing",
    ):
        response = all_archive_page(v, archive_filter(parse_qsl(query)), origin)
        out[name]["archive?" + query] = {
            "body": response.body.decode(),
            "headers": {
                key: response.headers.get(key)
                for key in (
                    "content-type",
                    "cache-control",
                    "content-security-policy",
                    "permissions-policy",
                    "referrer-policy",
                    "x-content-type-options",
                )
            },
        }
    out[name]["fallback"] = all_archive_page(
        v, {"sort": "date", "tag": "", "stream": ""}, origin, False
    ).body.decode()
    out[name]["sitemap"] = sitemap(v, origin)
    for path in ("part-0", "part-8"):
        out[name][path + ".feed"] = feed(v, path, origin)["body"]
        out[name][path + ".search"] = json.loads(search_index(v, path)["body"])
with open(output, "w") as target:
    json.dump(out, target, ensure_ascii=False)
