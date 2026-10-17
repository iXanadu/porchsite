"""The content guard (SPEC S6): refuses content that looks like a secret,
on every write, so it never sits in a draft or a revision. Port of
cloudflare/src/guard.ts (JavaScript's Unicode \\s, ASCII \\b)."""

import re
from typing import Any

from server.spec.jsutil import NOT_S, S

from .errors import ApiError

_F = re.ASCII
PATTERNS: list[tuple[str, re.Pattern]] = [
    ("a published-read key", re.compile(r"\bprk_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])", _F)),
    ("a private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----", _F)),
    ("an AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b", _F)),
    ("an API token", re.compile(r"\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}\b", _F)),
    ("a GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b", _F)),
    ("a Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b", _F)),
    ("a bearer token", re.compile(rf"\bBearer{S}+[A-Za-z0-9._~+/-]{{24,}}=*", _F | re.I)),
    ("a password", re.compile(rf"\b(password|passwd|pwd){S}*[:=]{S}*{NOT_S}{{4,}}", _F | re.I)),
    (
        "a private network address",
        re.compile(r"\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b", _F),
    ),
]


def _strings(v: Any, out: list[str]) -> list[str]:
    if isinstance(v, str):
        out.append(v)
    elif isinstance(v, list):
        for x in v:
            _strings(x, out)
    elif isinstance(v, dict):
        for x in v.values():
            _strings(x, out)
    return out


def check_guard(data: Any) -> None:
    text = "\n".join(_strings(data, []))
    for what, rx in PATTERNS:
        if rx.search(text):
            raise ApiError(
                422,
                "content_guard",
                f"This looks like it contains {what}. Remove it and save again.",
                {"rule": what},
            )
