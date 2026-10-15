"""WHATWG HTTPS source parsing; no DNS lookup or remote fetch."""

import ipaddress
import re
from urllib.parse import parse_qs, unquote

from ada_url import URL

EMBED_ADVICE = "An embed shows a video or tour from another site on your page. Each new source needs your approval; once approved, pages can show anything from that source."
EMBED_SYNTAX = "Put it on its own line in the body: !embed[Title](https://example.com/player)."
ERROR = "Use a public https:// origin, without a path, login, query or fragment."
FORBIDDEN = re.compile(r"[\s\x00-\x1f\x7f\ufeff\ud800-\udfff\\]")
HOST_FORBIDDEN = re.compile(r"[*\u3002\uff0e\uff61]")


_V4_DENY = (
    (0, 8),
    (10 << 24, 8),
    ((100 << 24) | (64 << 16), 10),
    (127 << 24, 8),
    ((169 << 24) | (254 << 16), 16),
    ((172 << 24) | (16 << 16), 12),
    (192 << 24, 24),
    ((192 << 24) | (2 << 8), 24),
    ((192 << 24) | (168 << 16), 16),
    ((198 << 24) | (18 << 16), 15),
    ((198 << 24) | (51 << 16) | (100 << 8), 24),
    ((203 << 24) | (113 << 8), 24),
    (224 << 24, 3),
)


def _public(host):
    if host == "localhost" or host.endswith((".localhost", ".")):
        return False
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return True
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped:
            return _public(str(ip.ipv4_mapped))
        return ip in ipaddress.ip_network("2000::/3") and not any(
            ip in ipaddress.ip_network(n) for n in ("2001::/23", "2001:db8::/32", "2002::/16")
        )
    n = int(ip)
    return not any(n >> (32 - bits) == base >> (32 - bits) for base, bits in _V4_DENY)


def embed_url(value: str, source: bool = False):
    if (
        len(value.encode("utf-16-le", errors="surrogatepass")) // 2 > 2000
        or not re.match(r"^https://", value, re.I)
        or FORBIDDEN.search(value)
    ):
        raise ValueError(ERROR)
    authority = re.split(r"[/?#]", value[8:], maxsplit=1)[0]
    decoded = unquote(authority, errors="strict")
    if (
        not authority
        or HOST_FORBIDDEN.search(decoded)
        or re.search(r"[;,]", decoded)
        or FORBIDDEN.search(decoded)
        or re.search(r"[@/?#]", decoded)
        or decoded.endswith(".")
    ):
        raise ValueError(ERROR)
    try:
        u = URL(value)
    except ValueError:
        raise ValueError(ERROR) from None
    if u.protocol != "https:" or u.username or u.password or not _public(u.hostname):
        raise ValueError(ERROR)
    if source and (u.pathname not in ("", "/") or value[8 + len(authority) :] not in ("", "/")):
        raise ValueError(ERROR)
    if not source and not u.port:
        qs = parse_qs(u.search.lstrip("?"), keep_blank_values=True)
        ident = None
        if u.hostname in (
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "youtu.be",
            "www.youtube-nocookie.com",
        ):
            if u.pathname == "/watch":
                ids = qs.get("v", [])
                if len(ids) > 1:
                    raise ValueError(ERROR)
                ident = ids[0] if ids else None
            elif u.hostname == "youtu.be":
                m = re.fullmatch(r"/([^/]+)/?", u.pathname)
                ident = m[1] if m else None
            else:
                m = re.fullmatch(r"/(?:shorts|embed)/([^/]+)/?", u.pathname)
                ident = m[1] if m else None
            if ident is not None:
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", ident):
                    raise ValueError(ERROR)
                return URL(f"https://www.youtube-nocookie.com/embed/{ident}")
        if u.hostname == "my.matterport.com" and u.pathname in ("/show", "/show/"):
            ids = qs.get("m", [])
            if len(ids) > 1:
                raise ValueError(ERROR)
            if ids:
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", ids[0]):
                    raise ValueError(ERROR)
                return URL(f"https://my.matterport.com/show/?m={ids[0]}")
    return u


def embed_sources(values):
    if len(values) > 20:
        raise ValueError(ERROR)
    out = [embed_url(v, True).origin for v in values]
    if len(set(out)) != len(out):
        raise ValueError("Each embed source may appear only once.")
    return out


def request_origin(origin):
    try:
        return URL(origin).origin
    except ValueError:
        return ""
