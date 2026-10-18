"""Owner review text only; never players."""

from ada_url import idna

from .embed_url import embed_url
from .embeds import embeds_of, safe_sources
from .html import esc


def _sources(rows):
    return safe_sources(
        next((r["data"].get("embed_sources") for r in rows if r["kind"] == "site"), [])
    )


def _count(rows, source):
    return sum(
        1
        for r in rows
        if r["kind"] == "entry" and r["data"].get("status") != "draft"
        for e in embeds_of(r["data"].get("body") or "")
        if e["origin"] == source
    )


def _source_text(source):
    u = embed_url(source, True)
    unicode = idna.decode(u.hostname.encode()) if not u.hostname.startswith("[") else u.hostname
    if isinstance(unicode, bytes):
        unicode = unicode.decode()
    display = (
        source
        if unicode == u.hostname
        else f"https://{unicode}{':' + u.port if u.port else ''} ({source})"
    )
    return display

def _label(source):
    return f'<bdi dir="ltr">{esc(_source_text(source))}</bdi>'


def embed_review(live, proposed, changes, origin, read=None):
    before, after = _sources(live), _sources(proposed)
    lines = []
    for source in [s for s in after if s not in before] + [s for s in before if s not in after]:
        added = source in after
        advice = (
            "This lets published pages show anything from this origin in a frame. That site can play sound, use fullscreen and open separate pages; it can see that the visitor came from this site. You are approving the whole source, not one video or tour."
            if added
            else "Its players become normal links."
        )
        if read is not None:
            read(f'{"Add embed source" if added else "Remove embed source"}: {_source_text(source)}. Published embeds: {_count(live, source)}; after this approval: {_count(proposed, source)}. {advice}')
        lines.append(
            f'<p class="warn">{"Add embed source" if added else "Remove embed source"}: {_label(source)}. Published embeds: {_count(live, source)}; after this approval: {_count(proposed, source)}. {advice}</p>'
        )
    for row in changes:
        if row["kind"] != "entry" or row.get("deleted"):
            continue
        for e in embeds_of(row["data"].get("body") or ""):
            status = (
                "this source is this site; only a link is allowed"
                if e["origin"] == origin
                else "source already approved"
                if e["origin"] in before
                else "source proposed in this approval"
                if e["origin"] in after
                else "source not approved"
            )
            if read is not None:
                read(f'Embed: {e["title"]} — {e["url"]}. Source: {_source_text(e["origin"])}; {status}.')
            lines.append(
                f'<p class="meta">Embed: {esc(e["title"])} — <bdi dir="ltr">{esc(e["url"])}</bdi>. Source: {_label(e["origin"])}; {status}.</p>'
            )
    return "".join(lines)
