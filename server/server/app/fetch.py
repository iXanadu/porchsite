"""Outbound HTTP, injectable (the Cloudflare edition passes a `fetcher` to the
same functions; tests pass fakes).

A fetcher is `async (url, method="GET", headers=None, content=None) ->
httpx.Response`. `fetch` is the plain one, for the catalog and the request
queue (fixed addresses under home.HOME). `public_fetch` is for addresses a
caller names (images copied in at save): https only, every hop's host must
resolve to public addresses only, the connection goes to the address that
was checked (so a second lookup can't swap in a private one), and it reads
at most a cap of bytes. It stands in for the Worker's
global_fetch_strictly_public flag.
"""

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable
from typing import Any, Protocol
from urllib.parse import urljoin, urlsplit

import httpcore
import httpx

TIMEOUT = httpx.Timeout(20.0, connect=10.0)
MAX_REDIRECTS = 5


class Fetcher(Protocol):
    def __call__(
        self,
        url: str,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        content: str | bytes | None = None,
    ) -> Awaitable[httpx.Response]: ...


async def fetch(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    content: str | bytes | None = None,
) -> httpx.Response:
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        return await client.request(method, url, headers=headers, content=content)


class NotPublicError(Exception):
    pass


async def _check_public(url: str, pins: dict[str, str]) -> None:
    """Refuse a URL whose host isn't https on public addresses only; pin the
    host to the checked address its connection must use."""
    if urlsplit(url).scheme != "https":
        raise NotPublicError(url)
    try:
        parsed = httpx.URL(url)
    except httpx.InvalidURL as e:
        raise NotPublicError(url) from e
    host = parsed.host
    if not host:
        raise NotPublicError(url)
    try:
        addrs = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(
                host, parsed.port or 443, type=socket.SOCK_STREAM
            )
        except OSError as e:
            raise NotPublicError(url) from e
        addrs = [ipaddress.ip_address(i[4][0].split("%")[0]) for i in infos]
    if not addrs or not all(a.is_global for a in addrs):
        raise NotPublicError(url)
    pins[host] = str(addrs[0])


class _Pinned(httpcore.AsyncNetworkBackend):
    """Connects only to the address _check_public pinned for each host. TLS
    still checks the certificate against the host's name."""

    def __init__(self, pins: dict[str, str]):
        self.pins = pins
        self.inner = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        ip = self.pins.get(host)
        if ip is None:
            raise NotPublicError(host)
        return await self.inner.connect_tcp(ip, port, timeout, local_address, socket_options)

    async def connect_unix_socket(self, *args: Any, **kwargs: Any) -> httpcore.AsyncNetworkStream:
        raise NotPublicError("unix socket")

    async def sleep(self, seconds: float) -> None:
        await self.inner.sleep(seconds)


def _pinned_transport(pins: dict[str, str]) -> httpx.AsyncHTTPTransport:
    # No proxy from the environment: a proxy would look the name up again.
    t = httpx.AsyncHTTPTransport(trust_env=False)
    t._pool = httpcore.AsyncConnectionPool(
        ssl_context=httpx.create_ssl_context(), network_backend=_Pinned(pins)
    )
    return t


def capped_public_fetch(cap: int):
    """A fetcher for caller-named addresses that reads at most cap + 1 bytes
    (enough for the caller to see it's over), and only from public hosts."""

    async def get(
        url: str, method: str = "GET", headers: dict[str, str] | None = None, content: Any = None
    ) -> httpx.Response:
        pins: dict[str, str] = {}
        async with httpx.AsyncClient(
            timeout=TIMEOUT,
            follow_redirects=False,
            trust_env=False,
            transport=_pinned_transport(pins),
        ) as client:
            for _ in range(MAX_REDIRECTS + 1):
                await _check_public(url, pins)
                req = client.build_request(method, url, headers=headers, content=content)
                res = await client.send(req, stream=True)
                try:
                    location = res.headers.get("location")
                    if res.is_redirect and location:
                        url = urljoin(url, location)
                        continue
                    kept = {
                        k: v
                        for k, v in res.headers.items()
                        if k.lower() not in ("content-encoding", "transfer-encoding")
                    }
                    declared = int(res.headers.get("content-length") or 0)
                    body = bytearray()
                    if declared <= cap:
                        async for part in res.aiter_bytes():
                            body += part
                            if len(body) > cap:
                                break
                    return httpx.Response(res.status_code, headers=kept, content=bytes(body))
                finally:
                    await res.aclose()
        raise NotPublicError(url)

    return get
