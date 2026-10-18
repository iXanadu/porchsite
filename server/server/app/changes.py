"""What the owner reads on /review and /review/history: an item's fields in
plain words ("What it says"), and, for an item that is already live, only
what differs from the live version ("What changed"): old → new for short
values, a word-level diff for long text, thumbnails for pictures, and
added/removed entries for lists. Every value is escaped; nothing from
content is ever inserted as HTML except through markdown(), which escapes.
Port of cloudflare/src/changes.ts (same strings, same structure).
"""

import json
import re
from typing import Any

from server.spec.jsutil import string

from .content import validate
from .errors import ApiError
from .html import esc, markdown
from .media import LOCAL
from .visibility import RANK

Data = dict[str, Any]

# Plain words for the fields a person sees on the review page.
LABELS = {
    "ai_training_disabled": "AI training",
    "title": "Name", "tagline": "Headline", "intro": "Intro", "description": "Description for search and shared links", "about": "About",
    "hero": "Main picture", "logo": "Mark (and browser icon)", "share_image": "Picture for shared links", "hero_caption": "Line under the masthead",
    "theme": "Look", "palette": "Colours", "links": "Menu", "buttons": "Buttons", "streams": "Sections", "archive": "All-stream archive", "sections": "Order of the home page",
    "cta_label": "Main button", "cta2_label": "Second button", "footer_line": "Footer", "contact": "Contact details", "hours": "Opening hours",
    "notice": "Banner", "handle": "X handle", "summary": "Summary", "body": "Text", "cover": "Picture", "date": "Date", "name": "Name",
    "price": "Price", "subtitle": "Second line", "period": "Dates", "image": "Picture", "event": "Event details", "stats": "Figures", "tags": "Tags",
    "follow_image": "Photo by the Follow link", "visibility": "Visibility", "link": "Link", "link_label": "Link words", "external_url": "Link",
    "badge": "Badge", "badge_tone": "Badge colour", "group": "Group", "sort": "Order", "status": "Status", "stream": "Section", "text": "Text",
    "owner_name": "Your name", "hero_alt": "Words for the main picture", "logo_alt": "Words for the mark", "follow_image_alt": "Words for the Follow photo",
    "share_image_alt": "Words for the shared-link picture", "cover_alt": "Words for the picture", "image_alt": "Words for the picture",
    "cta_link": "Main button link", "cta2_link": "Second button link",
}  # fmt: skip
# Per kind, where the shared word would mislead.
KIND_LABELS = {"card": {"description": "Description"}}
# Fields "What it says" leaves out (alt text, order, styling); "What changed"
# still shows them when they change.
SILENT = {"hero_alt", "logo_alt", "follow_image_alt", "share_image_alt", "cover_alt", "image_alt", "cta_link", "cta2_link", "sort", "status", "badge_tone", "stream"}  # fmt: skip

_MISSING = object()


def label_for(kind: str, k: str) -> str:
    return KIND_LABELS.get(kind, {}).get(k) or LABELS.get(k) or k.replace("_", " ")


def _js_json(v: Any) -> str:
    return json.dumps(v if v is not None else "", ensure_ascii=False, separators=(",", ":"))


def _same(a: Any, b: Any) -> bool:
    return _js_json(a) == _js_json(b)


def _dumps(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def plain_value(k: str, v: Any) -> str:
    if k == "ai_training_disabled":
        return "Blocked for training crawlers" if v is True else "Allowed"
    if k == "streams" and isinstance(v, list):
        return esc(" · ".join(_entry_name(x) for x in v))
    if k == "archive" and isinstance(v, dict):
        return esc(f"{'On' if v.get('enabled') else 'Off'} · {v.get('title', 'All entries')}")
    if isinstance(v, str):
        if not v:
            return '<span class="meta">(empty)</span>'
        if LOCAL.search(v):
            return f'<img src="{esc(v)}" alt="" style="max-width:100%;max-height:320px;height:auto;border-radius:8px">'
        if k in ("body", "about"):
            return markdown(v)
        return esc(v)
    if isinstance(v, list):
        named = []
        for x in v:
            if isinstance(x, dict):
                pick = next(
                    (x[k2] for k2 in ("label", "title", "value") if x.get(k2) is not None), ""
                )
                named.append(string(pick))
            else:
                named.append("null" if x is None else string(x))
        named = [x for x in named if x]
        return esc(" · ".join(named) if named else f"{len(v)} item{'' if len(v) == 1 else 's'}")
    if isinstance(v, dict):
        return "updated"
    return esc(string(v))


def field_rows(kind: str, now: Data) -> str:
    """What it says: every field with something in it (a new item, or one coming back)."""
    out = []
    for k, v in now.items():
        if k in SILENT:
            continue
        if v == "" or v is None or (isinstance(v, list) and not v):
            continue
        out.append(
            f'<div class="field"><b>{esc(label_for(kind, k))}</b><div class="value">{plain_value(k, v)}</div></div>'
        )
    return "".join(out)


def what_it_says(kind: str, now: Data, open_: bool) -> str:
    return f'<details{" open" if open_ else ""}><summary class="meta" style="cursor:pointer">What it says</summary>{field_rows(kind, now)}</details>'


# --- what changed ---------------------------------------------------------------------

LONG = 200  # text longer than this (or any body) gets a word diff instead of two copies
MAX_CELLS = 250_000  # past this many word pairs, the diff shows old and new whole
KEEP = 6  # an unchanged stretch longer than this shows only its ends


def _words(s: str) -> list[str]:
    return [w for w in re.split(r"[ \t\n\r]+", s) if w]


def word_diff(before: str, after: str) -> list[tuple[str, list[str]]]:
    """Word-level diff of two texts: runs of unchanged, removed and added words."""
    a = _words(before)
    b = _words(after)
    p = 0
    while p < len(a) and p < len(b) and a[p] == b[p]:
        p += 1
    s = 0
    while s < len(a) - p and s < len(b) - p and a[len(a) - 1 - s] == b[len(b) - 1 - s]:
        s += 1
    a1 = a[p : len(a) - s]
    b1 = b[p : len(b) - s]
    ops: list[tuple[str, str]] = [("same", w) for w in a[:p]]
    if len(a1) * len(b1) > MAX_CELLS:
        ops += [("del", w) for w in a1]
        ops += [("ins", w) for w in b1]
    else:
        # Longest common subsequence, table from the end.
        m, n = len(a1), len(b1)
        t = [[0] * (n + 1) for _ in range(m + 1)]
        for i in range(m - 1, -1, -1):
            for j in range(n - 1, -1, -1):
                t[i][j] = t[i + 1][j + 1] + 1 if a1[i] == b1[j] else max(t[i + 1][j], t[i][j + 1])
        i = j = 0
        while i < m or j < n:
            if i < m and j < n and a1[i] == b1[j]:
                ops.append(("same", a1[i]))
                i += 1
                j += 1
            elif j >= n or (i < m and t[i + 1][j] >= t[i][j + 1]):
                ops.append(("del", a1[i]))
                i += 1
            else:
                ops.append(("ins", b1[j]))
                j += 1
    ops += [("same", w) for w in a[len(a) - s :]]
    runs: list[tuple[str, list[str]]] = []
    for op, w in ops:
        if runs and runs[-1][0] == op:
            runs[-1][1].append(w)
        else:
            runs.append((op, [w]))
    return runs


def _diff_html(before: str, after: str) -> str:
    runs = word_diff(before, after)
    parts = []
    for idx, (op, ws) in enumerate(runs):
        if op == "del":
            parts.append(f"<del>{esc(' '.join(ws))}</del>")
        elif op == "ins":
            parts.append(f"<ins>{esc(' '.join(ws))}</ins>")
        elif len(ws) <= 2 * KEEP + 1:
            parts.append(esc(" ".join(ws)))
        elif idx == 0:
            parts.append(f"… {esc(' '.join(ws[-KEEP:]))}")
        elif idx == len(runs) - 1:
            parts.append(f"{esc(' '.join(ws[:KEEP]))} …")
        else:
            parts.append(f"{esc(' '.join(ws[:KEEP]))} … {esc(' '.join(ws[-KEEP:]))}")
    return f'<div class="value diff">{" ".join(parts)}</div>'


def _thumb(v: str) -> str:
    if not v:
        return '<span class="meta">(none)</span>'
    if LOCAL.search(v):
        return f'<img src="{esc(v)}" alt="" style="max-width:40%;max-height:96px;height:auto;border-radius:6px;vertical-align:middle">'
    return esc(v)


def _entry_name(x: Any) -> str:
    """One entry of a list, or one part of a group of settings, in a few words."""
    if isinstance(x, dict):
        if x.get("id") and x.get("title") and ("layout" in x or "dated_addresses" in x):
            return f"{x['title']} ({x['id']}) · {'By title' if x.get('sort') == 'title' else 'Newest first'} · /{x.get('path') or x['id']}/"
        main = None
        for k in ("label", "title", "value", "name", "kind", "day", "from"):
            if x.get(k) is not None:
                main = x[k]
                break
        url = x.get("url") if x.get("url") is not None else x.get("href")
        if main is not None and main != "":
            return f"{string(main)} ({string(url)})" if url else string(main)
        if url:
            return string(url)
        return _dumps(x)
    if isinstance(x, list):
        return _dumps(x)
    return string(x)


def _entries(v: Any) -> list[Any]:
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return [
            f"{k}: {_dumps(x) if isinstance(x, dict | list) else ('null' if x is None else string(x))}"
            for k, x in v.items()
        ]
    return []


def _list_change(old: Any, now: Any) -> str:
    a = _entries(old)
    b = _entries(now)
    had = {_dumps(x) for x in a}
    has = {_dumps(x) for x in b}
    added = [_entry_name(x) for x in b if _dumps(x) not in had]
    removed = [_entry_name(x) for x in a if _dumps(x) not in has]
    if not added and not removed:
        return '<div class="value">Same entries, in a new order.</div>'
    out = ""
    if added:
        out += f'<div class="value">Added: {esc(" · ".join(added))}</div>'
    if removed:
        out += (
            f'<div class="value">Removed: <span class="old">{esc(" · ".join(removed))}</span></div>'
        )
    return out


def _scalar(v: str) -> str:
    return '<span class="meta">(empty)</span>' if v == "" else esc(v)


def _change_row(kind: str, k: str, old: Any, now: Any) -> str:
    label = label_for(kind, k)

    def is_list(v: Any) -> bool:
        return isinstance(v, list | dict)

    if k == "ai_training_disabled":
        value = f'<div class="value"><span class="old">{plain_value(k, old)}</span> → {plain_value(k, now)}</div>'
    elif is_list(old) or is_list(now):
        value = _list_change(old, now)
    elif (isinstance(old, str) and LOCAL.search(old)) or (isinstance(now, str) and LOCAL.search(now)):  # fmt: skip
        o = "" if old is None else string(old)
        n = "" if now is None else string(now)
        value = f'<div class="value">{_thumb(o)} → {_thumb(n)}</div>'
    else:
        o = "" if old is None else string(old)
        n = "" if now is None else string(now)
        if o and n and (k in ("body", "about") or len(o) > LONG or len(n) > LONG):
            value = _diff_html(o, n)
        else:
            was = f'<span class="old">{esc(o)}</span>' if o else _scalar(o)
            value = f'<div class="value">{was} → {_scalar(n)}</div>'
    raise_ = ""
    if kind == "card" and k == "visibility":
        to = "public" if now is None else string(now)
        was_v = "public" if old is None else string(old)
        if RANK.get(to, 2) > RANK.get(was_v, 2):
            raise_ = '<p class="warn">Shows more of this card than your site does now.</p>'
    return f'<div class="field"><b>{esc(label)}</b>{value}{raise_}</div>'


def _full(kind: str, d: Data) -> Data:
    try:
        return validate(kind, d)
    except ApiError:
        return d


def what_changed(kind: str, now: Data, before: Data, extra: list[str] | None = None) -> str:
    """What changed: one row per field that differs from the live version, plus
    any extra rows (an address change). Unchanged fields are counted, not shown."""
    # With defaults filled in, a field one version leaves out and the other
    # stores at its default isn't a change. Data that no longer validates is compared as stored.
    now, before = _full(kind, now), _full(kind, before)
    keys = list(now) + [k for k in before if k not in now]
    rows = list(extra or [])
    unchanged = 0
    for k in keys:
        if _same(before.get(k), now.get(k)):
            if k not in SILENT:
                unchanged += 1
            continue
        rows.append(_change_row(kind, k, before.get(k), now.get(k)))
    body = (
        "".join(rows)
        if rows
        else '<p class="meta">Nothing you would see differs from what is live.</p>'
    )
    tail = (
        f'<p class="meta">{unchanged} other field{"" if unchanged == 1 else "s"} unchanged</p>'
        if unchanged
        else ""
    )
    return f'<details class="changed" open><summary class="meta" style="cursor:pointer">What changed</summary>{body}{tail}</details>'


def address_row(old: str, new: str) -> str:
    """The address row for an entry whose page moves."""
    return f'<div class="field"><b>Address</b><p>Address changes from {esc(old)} to {esc(new)}</p></div>'


def taken_off(label: str) -> str:
    return f"<p>This will be taken off the site: <b>{esc(label)}</b></p>"


# The owner's styles for the above (part of OWNER_CSS).
CHANGES_CSS = ".diff del{background:#f3dcd6;color:var(--deny)}.diff ins{background:#dcefe4;color:#1f4034;text-decoration:none}.field .warn{margin:6px 0 0}"


# Same visible list changes and bounded word-diff context as the HTML renderer.
def review_fields(kind, now, before=None, removed=False):
    from server.spec.models import MODELS
    from .owner_review import value, source, heading
    if removed:
        return [value('Status', 'This will be taken off the site.')]
    out = []
    if before is not None:
        now, before = _full(kind, now), _full(kind, before)
    unchanged = 0
    for k in MODELS[kind].model_fields:
        if before is not None and _same(before.get(k), now.get(k)):
            if k not in SILENT: unchanged += 1
            continue
        if before is None and (k in SILENT or now.get(k) is None or now.get(k) == '' or now.get(k) == []):
            continue
        out.append(heading(label_for(kind, k)))
        old, current = before.get(k) if before is not None else None, now.get(k)
        if before is not None and k != 'ai_training_disabled' and (isinstance(old, (dict,list)) or isinstance(current, (dict,list))):
            a, b = _entries(old), _entries(current)
            had, has = {_dumps(x) for x in a}, {_dumps(x) for x in b}
            added = [_entry_name(x) for x in b if _dumps(x) not in had]
            removed = [_entry_name(x) for x in a if _dumps(x) not in has]
            if added: out.append(value('Added', ' · '.join(added)))
            if removed: out.append(value('Removed', ' · '.join(removed)))
            if not added and not removed: out.append(value('Status','Same entries, in a new order.'))
            continue
        o, n = string(old), string(current)
        if before is not None and o and n and (k in ('body','about') or len(o)>LONG or len(n)>LONG):
            runs = word_diff(o,n)
            for i,(op,words) in enumerate(runs):
                text = ' '.join(words)
                if op == 'same' and len(words)>2*KEEP+1:
                    text = '… '+' '.join(words[-KEEP:]) if i==0 else ' '.join(words[:KEEP])+' …' if i==len(runs)-1 else ' '.join(words[:KEEP])+' … '+' '.join(words[-KEEP:])
                out.append(source('Before' if op=='del' else 'After' if op=='ins' else 'Unchanged context',text))
            continue
        def show(label, v):
            if k in ('body', 'about') and isinstance(v, str):
                out.append(source(label, v))
            elif k == 'ai_training_disabled':
                out.append(value(label, 'Blocked for training crawlers' if v is True else 'Allowed'))
            elif k == 'streams' and isinstance(v, list):
                out.append(value(label, ' · '.join(_entry_name(x) for x in v)))
            elif k == 'archive' and isinstance(v, dict):
                out.append(value(label, ('On' if v.get('enabled') else 'Off') + ' · ' + str(v.get('title', 'All entries'))))
            elif isinstance(v, list):
                named = [str(x.get('label', x.get('title', x.get('value', '')))) if isinstance(x, dict) else string(x) for x in v]
                named = [x for x in named if x]
                out.append(value(label, ' · '.join(named) if named else str(len(v)) + (' item' if len(v) == 1 else ' items')))
            else:
                out.append(value(label, 'updated' if isinstance(v, dict) else string(v)))
        if before is not None: show('Before', old)
        show('After' if before is not None else 'Value', current)
        if before is not None and kind=='card' and k=='visibility' and RANK.get(string(current) or 'public',2)>RANK.get(string(old) or 'public',2):
            out.append(value('Warning','Shows more of this card than your site does now.'))
    if before is not None and not out:
        out.append(value('Status', 'Nothing you would see differs from what is live.'))
    if before is not None and unchanged:
        out.append(value('Unchanged',f"{unchanged} other field{'' if unchanged==1 else 's'} unchanged"))
    return out
