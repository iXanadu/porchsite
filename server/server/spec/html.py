"""HTML helpers (port of cloudflare/src/html.ts: esc and markdown)."""

import re
from bisect import bisect_left
from typing import Any

from .jsutil import WS_CHARS, string, trim


def esc(v: Any) -> str:
    """Numeric entities for & < > " ' (String(v ?? ""))."""
    return re.sub(r"[&<>\"']", lambda m: f"&#{ord(m.group(0))};", string(v))


MAX_DEPTH = 16
_ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
_OPENS_QUOTE = "([{<-*_\"'/"
_URL_STOP = "\"'<>()[]`*"  # where a bare web address in text ends
_ALNUM = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")

_FENCE = re.compile(r"( {0,3})(`{3,}|~{3,})")
_FENCE_CLOSE = re.compile(r" {0,3}(`+|~+)[ \t]*")
_HEADING = re.compile(r" {0,3}(#{1,6})[ \t]+")
_HR = re.compile(r"([-*_])(?:[ \t]*\1){2,}")
_QUOTE = re.compile(r" {0,3}>")
_ITEM = re.compile(r"([ \t]*)([-*+]|[0-9]{1,9}[.)])[ \t]")
_MEDIA = re.compile(r"/media/[A-Za-z0-9._-]+\)")


def _is_ws(c: str | None) -> bool:
    return c is not None and c in WS_CHARS


def _is_blank(line: str) -> bool:
    return trim(line) == ""


def _is_word(c: str | None) -> bool:
    if c is None:
        return False
    n = ord(c)
    return c in _ALNUM or (n > 127 and not _is_ws(c) and not 0x2000 <= n <= 0x206F)


def _indent(line: str) -> int:
    col = 0
    for c in line:
        if c == " ":
            col += 1
        elif c == "\t":
            col += 4 - col % 4
        else:
            break
    return col


def _strip_cols(line: str, n: int) -> str:
    """Drops up to n columns of leading spaces and tabs."""
    col = i = 0
    while i < len(line) and col < n and line[i] in " \t":
        col += 1 if line[i] == " " else 4 - col % 4
        i += 1
    return line[i:]


def _strip_left(s: str) -> str:
    return s.lstrip(" \t")


def _fence(line: str) -> tuple[str, int, int, str] | None:
    m = _FENCE.match(line)
    if not m:
        return None
    info = line[m.end() :]
    if m.group(2)[0] == "`" and "`" in info:
        return None
    t = trim(info)
    j = 0
    while j < len(t) and not _is_ws(t[j]):
        j += 1
    return m.group(2)[0], len(m.group(2)), len(m.group(1)), t[:j]


def _fence_close(line: str, ch: str, n: int) -> bool:
    m = _FENCE_CLOSE.fullmatch(line)
    return bool(m) and m.group(1)[0] == ch and len(m.group(1)) >= n


def _heading(line: str) -> tuple[int, str] | None:
    m = _HEADING.match(line)
    if not m:
        return None
    text = trim(line[m.end() :])
    return (len(m.group(1)), text) if text else None


def _hr(line: str) -> bool:
    return _indent(line) < 4 and _HR.fullmatch(trim(line)) is not None


def _item(line: str) -> dict | None:
    m = _ITEM.match(line)
    if not m:
        return None
    k = _indent(m.group(1))
    mark = m.group(2)
    rest = line[len(m.group(1)) + len(mark) :]
    n = 0
    while n < len(rest) and rest[n] in " \t":
        n += 1
    kind = "ul" if len(mark) == 1 and mark in "-*+" else "ol"
    start = int(mark[:-1]) if kind == "ol" else 1
    if _is_blank(rest):
        return {"kind": kind, "start": start, "k": k, "w": k + len(mark) + 1, "first": ""}
    if n > 4:
        return {"kind": kind, "start": start, "k": k, "w": k + len(mark) + 1, "first": rest[1:]}
    return {"kind": kind, "start": start, "k": k, "w": k + len(mark) + n, "first": rest[n:]}


def _starts_block(line: str) -> bool:
    """A line that ends a lazy continuation (list item or quote)."""
    return _indent(line) < 4 and bool(
        _fence(line) or _heading(line) or _hr(line) or _QUOTE.match(line) or _item(line)
    )


def _interrupts(line: str, in_item: bool) -> bool:
    """A line that ends a paragraph. In a list item any number starts a
    nested list; elsewhere only 1. does."""
    if _indent(line) >= 4:
        return False
    if _fence(line) or _heading(line) or _hr(line) or _QUOTE.match(line):
        return True
    it = _item(line)
    return (
        bool(it) and trim(it["first"]) != "" and (it["kind"] == "ul" or it["start"] == 1 or in_item)
    )


def _heading_id(inner, used):
    text = re.sub(r"<[^>]*>", "", inner)
    text = re.sub(r"&#(\d+);", lambda m: chr(int(m[1])), text)
    text = re.sub(r"[A-Z]", lambda m: m[0].lower(), text)
    base = re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:64].rstrip("-") or "section"
    taken, next_suffix = used
    identifier = base
    if identifier in taken:
        count = next_suffix.get(base, 2)
        while True:
            identifier = f"{base}-{count}"
            count += 1
            if identifier not in taken:
                break
        next_suffix[base] = count
    taken.add(identifier)
    return identifier


def _blocks(
    lines: list[str], depth: int, in_item: bool = False, block=None, ids=None, body_h1_as_h2=False
) -> tuple[list[tuple[str, str | None]], bool]:
    """Block Markdown: [(html, paragraph's inline html or None)], and whether
    a blank line separated two of them (a loose list item)."""
    out: list[tuple[str, str | None]] = []
    gap = blank_before = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if _is_blank(line):
            blank_before = True
            i += 1
            continue
        if blank_before and out:
            gap = True
        blank_before = False
        if _indent(line) >= 4:
            code = []
            while i < len(lines) and (_is_blank(lines[i]) or _indent(lines[i]) >= 4):
                code.append(_strip_cols(lines[i], 4))
                i += 1
            while _is_blank(code[-1]):
                code.pop()
                blank_before = True
            out.append((f"<pre><code>{esc(chr(10).join(code) + chr(10))}</code></pre>", None))
            continue
        f = _fence(line)
        if f:
            ch, flen, indent, lang = f
            code = []
            i += 1
            while i < len(lines) and not _fence_close(lines[i], ch, flen):
                ln = lines[i]
                i += 1
                s = 0
                while s < indent and ln[:1] == " ":
                    ln = ln[1:]
                    s += 1
                code.append(ln)
            if i < len(lines):
                i += 1
            cls = f' class="language-{esc(lang)}"' if lang else ""
            body = "\n".join(code) + "\n" if code else ""
            out.append((f"<pre><code{cls}>{esc(body)}</code></pre>", None))
            continue
        special = block(line) if depth == 0 and block else None
        if special is not None:
            out.append((special, None))
            i += 1
            continue
        h = _heading(line)
        if h:
            inner = _inline(h[1])
            identifier = f' id="{_heading_id(inner, ids)}"' if ids is not None else ""
            level = 2 if body_h1_as_h2 and h[0] == 1 else h[0]
            out.append((f"<h{level}{identifier}>{inner}</h{level}>", None))
            i += 1
            continue
        if _hr(line):
            out.append(("<hr>", None))
            i += 1
            continue
        if depth < MAX_DEPTH and _QUOTE.match(line):
            inner: list[str] = []
            while i < len(lines):
                ln = lines[i]
                m = _QUOTE.match(ln)
                if m:
                    rest = ln[m.end() :]
                    inner.append(rest[1:] if rest[:1] in (" ", "\t") and rest else rest)
                elif not _is_blank(ln) and not _is_blank(inner[-1]) and not _starts_block(ln):
                    inner.append(_strip_left(ln))
                else:
                    break
                i += 1
            quoted = "".join(
                b[0] for b in _blocks(inner, depth + 1, ids=ids, body_h1_as_h2=body_h1_as_h2)[0]
            )
            out.append((f"<blockquote>{quoted}</blockquote>", None))
            continue
        first = _item(line) if depth < MAX_DEPTH else None
        if first:
            cur = first
            loose = False
            items: list[list[tuple[str, str | None]]] = []
            while True:
                content = [cur["first"]]
                prev_blank = False
                i += 1
                while i < len(lines):
                    ln = lines[i]
                    if _is_blank(ln):
                        content.append("")
                        prev_blank = True
                    else:
                        ind = _indent(ln)
                        if ind >= cur["w"]:
                            content.append(_strip_cols(ln, cur["w"]))
                        elif ind >= cur["k"] + 2 and _item(ln):
                            content.append(_strip_cols(ln, ind))
                        elif not prev_blank and not _starts_block(ln):
                            content.append(_strip_left(ln))
                        else:
                            break
                        prev_blank = False
                    i += 1
                trailing = 0
                while content and _is_blank(content[-1]):
                    content.pop()
                    trailing += 1
                bs, item_gap = _blocks(
                    content, depth + 1, True, ids=ids, body_h1_as_h2=body_h1_as_h2
                )
                if item_gap:
                    loose = True
                items.append(bs)
                nxt = _item(lines[i]) if i < len(lines) else None
                if nxt and nxt["kind"] == first["kind"] and _indent(lines[i]) < 4:
                    if trailing:
                        loose = True
                    cur = nxt
                    continue
                blank_before = trailing > 0
                break
            lis = "".join(
                "<li>" + "".join(p if not loose and p is not None else h for h, p in bs) + "</li>"
                for bs in items
            )
            if first["kind"] == "ul":
                opening = "<ul>"
            elif first["start"] != 1:
                opening = f'<ol start="{first["start"]}">'
            else:
                opening = "<ol>"
            out.append((f"{opening}{lis}</{first['kind']}>", None))
            continue
        para = [_strip_left(line)]
        i += 1
        spans = None
        offset = len(para[0]) + 1
        while i < len(lines) and not _is_blank(lines[i]) and not _interrupts(lines[i], in_item):
            if depth == 0 and block and lines[i].startswith("!embed["):
                if not any("`" in p for p in para):
                    break
                if spans is None:
                    rest = []
                    j = i
                    while (
                        j < len(lines)
                        and not _is_blank(lines[j])
                        and not _interrupts(lines[j], in_item)
                    ):
                        rest.append(_strip_left(lines[j]))
                        j += 1
                    probe = _inline("\n".join(para + rest).rstrip(" \t"), True)
                    spans = [
                        (int(a), int(b))
                        for a, b in re.findall(r'<code data-md-code="(\d+):(\d+)">', probe)
                    ]
                if not any(start <= offset < end for start, end in spans):
                    break
            nxt = _strip_left(lines[i])
            para.append(nxt)
            offset += len(nxt) + 1
            i += 1
        text = _inline("\n".join(para).rstrip(" \t"))
        out.append((f"<p>{text}</p>", text))
    return out, gap


def _inline(s: str, positions=False) -> str:
    """Inline Markdown for one paragraph or heading: code, images, links,
    emphasis, breaks, smart punctuation."""
    # Lookup tables keep the scan near-linear however the text is built.
    n = len(s)
    run_end = [n] * (n + 1)  # end of the run of equal characters at i
    next_close = [-1] * (n + 1)  # next "]" at or after i, else -1
    next_stop = [n] * (n + 1)  # next whitespace or ")" at or after i, else n
    next_quote = [-1] * (n + 1)  # next '"' at or after i, else -1
    next_text = [n] * (n + 1)  # next non-whitespace at or after i, else n
    for i in range(n - 1, -1, -1):
        c = s[i]
        run_end[i] = run_end[i + 1] if i + 1 < n and s[i + 1] == c else i + 1
        next_close[i] = i if c == "]" else next_close[i + 1]
        next_stop[i] = i if c in WS_CHARS or c == ")" else next_stop[i + 1]
        next_quote[i] = i if c == '"' else next_quote[i + 1]
        next_text[i] = next_text[i + 1] if c in WS_CHARS else i
    match = [-1] * n  # "[" -> its "]", backslash escapes skipped
    stack: list[int] = []
    i = 0
    while i < n:
        if s[i] == "\\":
            i += 1
        elif s[i] == "[":
            stack.append(i)
        elif s[i] == "]" and stack:
            match[stack.pop()] = i
        i += 1
    ticks: dict[int, list[int]] = {}  # backtick run length -> where such runs start
    i = 0
    while i < n:
        if s[i] == "`":
            ticks.setdefault(run_end[i] - i, []).append(i)
            i = run_end[i]
        else:
            i += 1

    def tick_run(i: int, length: int) -> int:
        """The first backtick run of exactly length that starts at or after i, else -1."""
        at = ticks.get(length, [])
        j = bisect_left(at, i)
        return at[j] if j < len(at) else -1

    def run(i: int, end: int) -> int:
        return min(run_end[i], end) - i

    def at(i: int) -> str | None:
        return s[i] if 0 <= i < n else None

    def link_dest(a: int, length: int) -> bool:
        """A link may go to http(s), mailto, "/..." or "#...": the address s[a:a+length]."""
        return (
            ((s.startswith("http://", a) or s.startswith("mailto:", a)) and length > 7)
            or (s.startswith("https://", a) and length > 8)
            or (at(a) in ("/", "#") and length > 0)
        )

    memo: dict[tuple, tuple[str, int] | None] = {}
    # Where a failed emphasis scan went: another scan for the same closer that reaches one of these fails too.
    dead: dict[tuple, set[int]] = {}

    def parse(start: int, end: int, close: str, need: int, no_links: bool, depth: int):
        key = (start, end, close, need, no_links)
        if key in memo:
            return memo[key]
        out: list[str] = []
        i = start
        res = None
        gone = dead.setdefault((end, close, need, no_links), set())
        seen: list[int] = []
        while i < end:
            if close:
                if i > start and i in gone:
                    break
                seen.append(i)
            c = s[i]
            if c in "*_":
                r = run(i, end)
                after = s[i + r] if i + r < end else None
                if (
                    c == close
                    and i > start
                    and not _is_ws(s[i - 1])
                    and r >= need
                    and (c == "*" or not _is_word(after))
                ):
                    res = ("".join(out), i + need)
                    break
                can_open = (
                    after is not None
                    and not _is_ws(after)
                    and (c == "*" or not _is_word(at(i - 1)))
                )
                if can_open and depth < MAX_DEPTH:
                    done = False
                    for w in (2, 1) if r >= 2 else (1,):
                        inner = parse(i + w, end, c, w, no_links, depth + 1)
                        if inner:
                            tag = "strong" if w == 2 else "em"
                            out.append(f"<{tag}>{inner[0]}</{tag}>")
                            i = inner[1]
                            done = True
                            break
                    if done:
                        continue
                out.append(c)
                i += 1
                continue
            if s.startswith("!embed[", i) or s.startswith("\\!embed[", i):
                start = i + 1 if c == "\\" else i
                stop = s.find(")", start, end)
                to = end if stop < 0 else stop + 1
                out.append(esc(s[start:to]))
                i = to
                continue
            if c == "\\":
                nx = s[i + 1] if i + 1 < end else ""
                if nx == "\n":
                    out.append("<br>")
                    i += 2
                elif nx and nx in _ASCII_PUNCT:
                    out.append(esc(nx))
                    i += 2
                else:
                    out.append("\\")
                    i += 1
                continue
            if c == "`":
                t = run(i, end)
                found = tick_run(i + t, t)
                if found < 0 or found >= end:
                    out.append("`" * t)
                    i += t
                    continue
                code = s[i + t : found].replace("\n", " ")
                if len(code) > 2 and code[0] == " " and code[-1] == " " and trim(code) != "":
                    code = code[1:-1]
                out.append(
                    f"<code{f' data-md-code="{i}:{found + t}"' if positions else ''}>{esc(code)}</code>"
                )
                i = found + t
                continue
            if c == "!" and at(i + 1) == "[" and i + 1 < end:
                k = next_close[i + 2]
                if 0 <= k < end and at(k + 1) == "(":
                    m = _MEDIA.match(s, k + 2)
                    if m and m.end() <= end:
                        alt = s[i + 2 : k].replace("\n", " ")
                        out.append(f'<img alt="{esc(alt)}" src="{m.group(0)[:-1]}">')
                        i = m.end()
                        continue
                out.append("!")
                i += 1
                continue
            if c == "[" and not no_links and depth < MAX_DEPTH:
                k = match[i]
                if 0 <= k < end and k > i + 1 and at(k + 1) == "(":
                    a = min(k + 2, end)
                    stop = min(next_stop[a], end)
                    p = min(next_text[stop], end)
                    title = -1  # where the title's closing quote is
                    if p < end and s[p] == '"':
                        q = next_quote[p + 1]
                        if 0 <= q < end:
                            title = q
                            p = min(next_text[q + 1], end)
                        else:
                            p = end
                    if p < end and s[p] == ")" and link_dest(a, stop - a):
                        text = parse(i + 1, k, "", 0, True, depth + 1)
                        if text:
                            t = ""
                            if title >= 0:
                                t = f' title="{esc(s[next_text[stop] + 1 : title].replace(chr(10), " "))}"'
                            out.append(f'<a href="{esc(s[a:stop])}"{t}>{text[0]}</a>')
                            i = p + 1
                            continue
                out.append("[")
                i += 1
                continue
            if (s.startswith("http://", i) or s.startswith("https://", i)) and not _is_word(
                at(i - 1)
            ):
                j = i
                while j < end and not _is_ws(s[j]) and s[j] not in _URL_STOP:
                    j += 1
                out.append(esc(s[i:j]))
                i = j
                continue
            if c == "-":
                d = run(i, end)
                i += d
                if d == 1:
                    out.append("-")
                else:
                    while d >= 3:
                        out.append("—")
                        d -= 3
                    out.append("–" if d == 2 else "-" if d == 1 else "")
                continue
            if c == "." and s.startswith("...", i) and i + 3 <= end:
                out.append("…")
                i += 3
                continue
            if c in "'\"":
                prev = at(i - 1)
                nxt = at(i + 1)
                opens = (
                    (prev is None or _is_ws(prev) or prev in _OPENS_QUOTE)
                    and nxt is not None
                    and not _is_ws(nxt)
                )
                if c == "'":
                    out.append("‘" if opens else "’")
                else:
                    out.append("“" if opens else "”")
                i += 1
                continue
            if c == " ":
                sp = run(i, end)
                if i + sp < end and s[i + sp] == "\n":
                    out.append("<br>" if sp >= 2 else " ")
                    i += sp + 1
                else:
                    out.append(" " * sp)
                    i += sp
                continue
            if c == "\n":
                out.append(" ")
                i += 1
                continue
            out.append(esc(c))
            i += 1
        if res is None and not close:
            res = ("".join(out), i)
        if res is None:
            gone.update(v for v in seen if v > start)
        memo[key] = res
        return res

    done = parse(0, n, "", 0, False, 0)
    return done[0] if done else ""


def markdown(src: str, block=None, heading_ids=False, body_h1_as_h2=False) -> str:
    """Markdown, safe and deliberately small (spec/SPEC.md, "Markdown"): a
    line-for-line port of cloudflare/src/html.ts; both must give the same
    bytes (spec/markdown-cases.json)."""
    lines = src.replace("\r\n", "\n").split("\n")
    return "\n".join(
        b[0]
        for b in _blocks(
            lines,
            0,
            block=block,
            ids=(set(), {}) if heading_ids else None,
            body_h1_as_h2=body_h1_as_h2,
        )[0]
    )
