"""Public discovery from approved live content, without rendering Markdown."""

from datetime import UTC, datetime

from .theme import streams

SITEMAP_HEADERS = {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=300",
}


def robots(origin):
    return f"User-agent: *\nAllow: /\nSitemap: {origin}/sitemap.xml\n"


def _xml(value):
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def sitemap(v, origin, archives=True):
    dates = {}
    for identifier, at in v.approved_at.items():
        try:
            dates[identifier] = (
                datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(UTC).date().isoformat()
            )
        except (ValueError, OverflowError):
            pass

    def latest(ids):
        return max((dates.get(identifier, "") for identifier in ids), default="")

    urls = {}

    def add(path, date):
        urls.setdefault(path, date)

    add("/", latest(["site"] + [str(e["id"]) for e in v.entries + v.cards + v.notes]))
    for e in v.entries:
        if not e.get("external_url"):
            add(str(e["page"]), dates.get(str(e["id"]), ""))
    if v.site.get("archive", {}).get("enabled"):
        add("/archive/", latest(["site"] + [str(e["id"]) for e in v.entries]))
    if archives:
        groups = {}
        for e in v.entries:
            groups.setdefault(str(e["stream"]), []).append(e)
        for stream in streams(v.site):
            items = groups.get(str(stream["id"]), [])
            add(str(stream["archive_url"]), latest(["site"] + [str(e["id"]) for e in items]))
            tags = {}
            for e in items:
                for tag in e.get("tags") or []:
                    tags.setdefault(tag, []).append(str(e["id"]))
            for tag in sorted(tags):
                add(f"{stream['archive_url']}tags/{tag}/", latest(["site"] + tags[tag]))
    rows = "".join(
        f"<url><loc>{_xml(origin + path)}</loc>"
        + (f"<lastmod>{date}</lastmod>" if date else "")
        + "</url>\n"
        for path, date in urls.items()
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + rows
        + "</urlset>\n"
    )
