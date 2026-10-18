"""Engine combined archive: port-matched escaped markup and exact filters."""

import re

from .html import esc


def archive_filter(pairs):
    out = {"sort": "date", "tag": "", "stream": ""}
    seen = set()
    for key, value in pairs:
        if key not in out or key in seen:
            raise ValueError("Invalid archive filters.")
        seen.add(key)
        if key == "sort":
            if value and value not in ("date", "stream"):
                raise ValueError("Invalid archive filters.")
            value = value or "date"
        # Keep fullmatch: a $ anchor alone can accept a final newline.
        elif value and not re.fullmatch(
            r"[a-z0-9-]{1,30}" if key == "tag" else r"[a-z][a-z0-9-]{0,29}", value
        ):
            raise ValueError("Invalid archive filters.")
        out[key] = value
    return out


def archive_main(v, selected, stream_archives=True):
    streams = v.site["streams"]
    tags = {}
    for e in v.entries:
        for tag in set(e.get("tags") or []):
            tags[tag] = tags.get(tag, 0) + 1

    def option(value, label, current):
        return f'<option value="{esc(value)}"{" selected" if value == current else ""}>{esc(label)}</option>'

    stream_options = [option(s["id"], s["title"], selected["stream"]) for s in streams]
    if selected["stream"] and not any(s["id"] == selected["stream"] for s in streams):
        stream_options.append(option(selected["stream"], selected["stream"], selected["stream"]))
    tag_options = [option(t, f"{t} ({tags[t]})", selected["tag"]) for t in sorted(tags)]
    if selected["tag"] and selected["tag"] not in tags:
        tag_options.append(option(selected["tag"], f"{selected['tag']} (0)", selected["tag"]))
    entries = [
        e
        for e in v.entries
        if (not selected["stream"] or e["stream"] == selected["stream"])
        and (not selected["tag"] or selected["tag"] in (e.get("tags") or []))
    ]
    if selected["sort"] == "stream":
        order = {s["id"]: i for i, s in enumerate(streams)}
        entries.sort(key=lambda e: order[e["stream"]])
    rows, previous = [], ""
    for e in entries:
        stream = next(s for s in streams if s["id"] == e["stream"])
        if selected["sort"] == "stream" and previous != stream["id"]:
            rows.append(f"<h2>{esc(stream['title'])}</h2>")
        previous = stream["id"]
        stream_url = (
            f"/{stream['path'] or stream['id']}/"
            if stream_archives
            else f"/archive/?stream={stream['id']}"
        )
        summary = f"<p>{esc(e['summary'])}</p>" if e.get("summary") else ""
        tag_text = (
            '<p class="meta">' + "".join(f"<span>#{esc(t)}</span> " for t in e["tags"]) + "</p>"
            if e.get("tags")
            else ""
        )
        rows.append(
            f'<article class="entry"><p class="meta"><time datetime="{esc(e["date"])}">{esc(e["date"])}</time> · <a href="{esc(stream_url)}">{esc(stream["title"])}</a></p><h3><a href="{esc(e["url"])}">{esc(e["title"])}</a></h3>{summary}{tag_text}</article>'
        )
    return (
        '<style>.archive-filters{display:flex;flex-wrap:wrap;gap:12px;align-items:end}.archive-filters label{display:block;min-width:0;max-width:100%}.archive-filters select{display:block;max-width:100%;font:inherit}.entry{overflow-wrap:anywhere}</style><p><a href="/">Home</a></p>'
        + f'<h1>{esc(v.site["archive"]["title"])}</h1><form class="archive-filters" method="get" action="/archive/"><label>Order<select name="sort">'
        + option("date", "By date", selected["sort"])
        + option("stream", "By stream", selected["sort"])
        + '</select></label><label>Stream<select name="stream">'
        + option("", "All streams", selected["stream"])
        + "".join(stream_options)
        + '</select></label><label>Tag<select name="tag">'
        + option("", "All tags", selected["tag"])
        + "".join(tag_options)
        + '</select></label><button type="submit">Apply</button></form>'
        + ("".join(rows) if rows else "<p>No entries match.</p>")
    )
