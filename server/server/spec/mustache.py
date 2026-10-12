"""Mustache, as mustache.js 4.2.0 renders it (the Cloudflare edition's
renderer), ported line by line. pystache follows the Mustache spec, and
mustache.js departs from it in ways a page's bytes show: a line holding only
section tags drops its newline even with several tags on it, a partial that
is the first tag on its line is indented by the width of the text before it,
a dotted name that fails in one context is retried in the ones below, and a
missing name is blank. Byte parity needs those quirks, so they live here.

Values are JSON-shaped: dict (object), list (array), str, int/float (number),
bool, None (null/undefined).
"""

import re
from collections.abc import Callable
from typing import Any

from .jsutil import S, string

_NON_SPACE = re.compile(rf"[^{S[1:-1]}]")
_WHITE = re.compile(rf"{S}*")
_EQUALS = re.compile(rf"{S}*=")
_CURLY = re.compile(rf"{S}*\}}")
_TAG = re.compile(r"#|\^|/|>|\{|&|=|!")
_SPACE = re.compile(rf"{S}+")


def _is_whitespace(s: str) -> bool:
    return not _NON_SPACE.search(s)


def _escape_re(s: str) -> str:
    return re.sub(r"[\-\[\]{}()*+?.,\\^$|#\s]", lambda m: "\\" + m.group(0), s)


def truthy(v: Any) -> bool:
    """JavaScript's !!v for JSON-shaped values: an empty object or array is truthy."""
    if v is None or v is False:
        return False
    if isinstance(v, bool):
        return True
    if isinstance(v, int | float):
        return v == v and v != 0
    if isinstance(v, str):
        return v != ""
    return True


class _Scanner:
    def __init__(self, s: str) -> None:
        self.string = s
        self.tail = s
        self.pos = 0

    def eos(self) -> bool:
        return self.tail == ""

    def scan(self, rx: re.Pattern) -> str:
        m = rx.search(self.tail)
        if not m or m.start() != 0:
            return ""
        s = m.group(0)
        self.tail = self.tail[len(s) :]
        self.pos += len(s)
        return s

    def scan_until(self, rx: re.Pattern) -> str:
        m = rx.search(self.tail)
        index = m.start() if m else -1
        if index == -1:
            match, self.tail = self.tail, ""
        elif index == 0:
            match = ""
        else:
            match, self.tail = self.tail[:index], self.tail[index:]
        self.pos += len(match)
        return match


def parse(template: str, tags: tuple[str, str] = ("{{", "}}")) -> list:
    """Breaks the template into a tree of tokens (parseTemplate)."""
    if not template:
        return []
    state = {
        "line_has_non_space": False,
        "has_tag": False,
        "non_space": False,
        "indentation": "",
        "tag_index": 0,
    }
    sections: list[list] = []
    tokens: list[Any] = []
    spaces: list[int] = []

    def strip_space() -> None:
        nonlocal spaces
        if state["has_tag"] and not state["non_space"]:
            while spaces:
                tokens[spaces.pop()] = None
        else:
            spaces = []
        state["has_tag"] = False
        state["non_space"] = False

    rx: dict[str, re.Pattern] = {}

    def compile_tags(t: Any) -> None:
        if isinstance(t, str):
            t = _SPACE.split(t, maxsplit=2)[:2]
        if not isinstance(t, list | tuple) or len(t) != 2:
            raise ValueError(f"Invalid tags: {t}")
        rx["open"] = re.compile(_escape_re(t[0]) + f"{S}*")
        rx["close"] = re.compile(f"{S}*" + _escape_re(t[1]))
        rx["close_curly"] = re.compile(f"{S}*" + _escape_re("}" + t[1]))

    compile_tags(tags)
    scanner = _Scanner(template)
    while not scanner.eos():
        start = scanner.pos
        value = scanner.scan_until(rx["open"])
        for chr_ in value:
            if _is_whitespace(chr_):
                spaces.append(len(tokens))
                state["indentation"] += chr_
            else:
                state["non_space"] = True
                state["line_has_non_space"] = True
                state["indentation"] += " "
            tokens.append(["text", chr_, start, start + 1])
            start += 1
            if chr_ == "\n":
                strip_space()
                state["indentation"] = ""
                state["tag_index"] = 0
                state["line_has_non_space"] = False
        if not scanner.scan(rx["open"]):
            break
        state["has_tag"] = True
        type_ = scanner.scan(_TAG) or "name"
        scanner.scan(_WHITE)
        if type_ == "=":
            value = scanner.scan_until(_EQUALS)
            scanner.scan(_EQUALS)
            scanner.scan_until(rx["close"])
        elif type_ == "{":
            value = scanner.scan_until(rx["close_curly"])
            scanner.scan(_CURLY)
            scanner.scan_until(rx["close"])
            type_ = "&"
        else:
            value = scanner.scan_until(rx["close"])
        if not scanner.scan(rx["close"]):
            raise ValueError(f"Unclosed tag at {scanner.pos}")
        if type_ == ">":
            token = [
                type_,
                value,
                start,
                scanner.pos,
                state["indentation"],
                state["tag_index"],
                state["line_has_non_space"],
            ]
        else:
            token = [type_, value, start, scanner.pos]
        state["tag_index"] += 1
        tokens.append(token)
        if type_ in ("#", "^"):
            sections.append(token)
        elif type_ == "/":
            if not sections:
                raise ValueError(f'Unopened section "{value}" at {start}')
            open_section = sections.pop()
            if open_section[1] != value:
                raise ValueError(f'Unclosed section "{open_section[1]}" at {start}')
        elif type_ in ("name", "{", "&"):
            state["non_space"] = True
        elif type_ == "=":
            compile_tags(value)
    strip_space()
    if sections:
        raise ValueError(f'Unclosed section "{sections[-1][1]}" at {scanner.pos}')
    return _nest(_squash(tokens))


def _squash(tokens: list) -> list:
    out: list = []
    last = None
    for token in tokens:
        if token:
            if token[0] == "text" and last and last[0] == "text":
                last[1] += token[1]
                last[3] = token[3]
            else:
                out.append(token)
                last = token
    return out


def _nest(tokens: list) -> list:
    nested: list = []
    collector = nested
    sections: list = []
    for token in tokens:
        if token[0] in ("#", "^"):
            collector.append(token)
            sections.append(token)
            token.extend([None, None])
            token[4] = collector = []
        elif token[0] == "/":
            section = sections.pop()
            section[5] = token[2]
            collector = sections[-1][4] if sections else nested
        else:
            collector.append(token)
    return nested


# --- context ---------------------------------------------------------------------------


def _has_property(obj: Any, name: str) -> bool:
    """obj != null && typeof obj === 'object' && name in obj"""
    if isinstance(obj, dict):
        return name in obj
    if isinstance(obj, list):
        return name == "length" or (
            name.isdigit() and str(int(name)) == name and int(name) < len(obj)
        )
    return False


def _primitive_has_own(obj: Any, name: str) -> bool:
    if isinstance(obj, str):
        return name == "length" or (
            name.isdigit() and str(int(name)) == name and int(name) < len(obj)
        )
    return False


def _member(obj: Any, name: str) -> Any:
    """obj[name], None for undefined."""
    if isinstance(obj, dict):
        return obj.get(name)
    if isinstance(obj, list | str) and (_has_property(obj, name) or _primitive_has_own(obj, name)):
        return len(obj) if name == "length" else obj[int(name)]
    return None


class Context:
    def __init__(self, view: Any, parent: "Context | None" = None) -> None:
        self.view = view
        self.cache: dict[str, Any] = {".": view}
        self.parent = parent

    def push(self, view: Any) -> "Context":
        return Context(view, self)

    def lookup(self, name: str) -> Any:
        if name in self.cache:
            return self.cache[name]
        value = None
        context: Context | None = self
        while context:
            hit = False
            if name.find(".") > 0:
                inter = context.view
                names = name.split(".")
                index = 0
                while inter is not None and index < len(names):
                    if index == len(names) - 1:
                        hit = _has_property(inter, names[index]) or _primitive_has_own(
                            inter, names[index]
                        )
                    inter = _member(inter, names[index])
                    index += 1
            else:
                inter = _member(context.view, name)
                hit = _has_property(context.view, name)
            if hit:
                value = inter
                break
            context = context.parent
        self.cache[name] = value
        return value


# --- writer ----------------------------------------------------------------------------


class Writer:
    def __init__(self, escape: Callable[[str], str]) -> None:
        self.escape = escape
        self._cache: dict[str, list] = {}

    def parse(self, template: str) -> list:
        tokens = self._cache.get(template)
        if tokens is None:
            tokens = self._cache[template] = parse(template)
        return tokens

    def render(self, template: str, view: Any, partials: dict[str, str] | None = None) -> str:
        context = view if isinstance(view, Context) else Context(view)
        return self._tokens(self.parse(template), context, partials, template)

    def _tokens(
        self, tokens: list, context: Context, partials: dict[str, str] | None, original: str
    ) -> str:
        buf = []
        for token in tokens:
            symbol = token[0]
            value = None
            if symbol == "#":
                value = self._section(token, context, partials, original)
            elif symbol == "^":
                value = self._inverted(token, context, partials, original)
            elif symbol == ">":
                value = self._partial(token, context, partials)
            elif symbol == "&":
                v = context.lookup(token[1])
                value = None if v is None else string(v)
            elif symbol == "name":
                v = context.lookup(token[1])
                value = None if v is None else self.escape(string(v))
            elif symbol == "text":
                value = token[1]
            if value is not None:
                buf.append(value)
        return "".join(buf)

    def _section(
        self, token: list, context: Context, partials: dict[str, str] | None, original: str
    ) -> str | None:
        value = context.lookup(token[1])
        if not truthy(value):
            return None
        if isinstance(value, list):
            return "".join(
                self._tokens(token[4], context.push(x), partials, original) for x in value
            )
        if isinstance(value, dict | str) or (
            isinstance(value, int | float) and not isinstance(value, bool)
        ):
            return self._tokens(token[4], context.push(value), partials, original)
        return self._tokens(token[4], context, partials, original)

    def _inverted(
        self, token: list, context: Context, partials: dict[str, str] | None, original: str
    ) -> str | None:
        value = context.lookup(token[1])
        if not truthy(value) or (isinstance(value, list) and len(value) == 0):
            return self._tokens(token[4], context, partials, original)
        return None

    @staticmethod
    def indent_partial(partial: str, indentation: str, line_has_non_space: bool) -> str:
        filtered = re.sub(r"[^ \t]", "", indentation)
        lines = partial.split("\n")
        for i, line in enumerate(lines):
            if line and (i > 0 or not line_has_non_space):
                lines[i] = filtered + line
        return "\n".join(lines)

    def _partial(
        self, token: list, context: Context, partials: dict[str, str] | None
    ) -> str | None:
        if not partials:
            return None
        value = partials.get(token[1])
        if value is None:
            return None
        line_has_non_space, tag_index, indentation = token[6], token[5], token[4]
        indented = value
        if tag_index == 0 and indentation:
            indented = self.indent_partial(value, indentation, line_has_non_space)
        return self._tokens(self.parse(indented), context, partials, indented)


def render(
    template: str,
    view: Any,
    partials: dict[str, str] | None = None,
    escape: Callable[[str], str] | None = None,
) -> str:
    return Writer(escape or (lambda s: s)).render(template, view, partials)
