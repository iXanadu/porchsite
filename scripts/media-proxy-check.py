#!/usr/bin/env python3
"""Exercise the documented Nginx cache policy against a disposable local origin.

No external traffic, TLS setup, production content or existing Nginx daemon.
Run under the same suite lock as the edition tests.
"""

import hashlib
import http.client
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BODY = bytes([255, 216, 255, 224, 0, 128, 254])
TAG = 'W/"sha256-' + hashlib.sha256(BODY).hexdigest() + '"'
BLANK = b'<!doctype html><meta name="robots" content="noindex"><title></title>'


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run(override):
    state = {"published": True, "private": False, "failure": False, "calls": []}

    class Origin(BaseHTTPRequestHandler):
        def do_GET(self):
            self.answer()

        def do_HEAD(self):
            self.answer()

        def log_message(self, *args):
            pass

        def answer(self):
            cookie = self.headers.get("Cookie", "")
            actor = (
                "owner"
                if "__Host-sk_owner=" in cookie
                else "reader"
                if "__Host-sk_reader=" in cookie
                else "authorization"
                if self.headers.get("Authorization")
                else ""
            )
            state["calls"].append(
                (self.command, cookie, self.headers.get("Authorization"))
            )
            status, body, cache = 200, BODY, "no-cache, no-transform"
            headers = {}
            if state["failure"]:
                status, body, cache = 503, b"origin unavailable", "no-store"
            elif state["private"] and not actor:
                status, body, cache = 404, BLANK, "private, no-store, no-transform"
            elif not state["published"]:
                status, body, cache = 404, b"missing", "no-store"
            elif actor:
                body, cache = actor.encode() + BODY, "private, no-store, no-transform"
            else:
                headers["ETag"] = TAG
                if self.headers.get("If-None-Match") in (TAG, "*"):
                    status, body = 304, b""
            self.send_response(status)
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Type", "image/jpeg")
            for name, value in headers.items():
                self.send_header(name, value)
            if status != 304:
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

    origin = ThreadingHTTPServer(("127.0.0.1", 0), Origin)
    thread = threading.Thread(target=origin.serve_forever, daemon=True)
    thread.start()
    process = None
    try:
        snippet = (
            (ROOT / "deploy/compose/README.md")
            .read_text()
            .split("```nginx\n", 1)[1]
            .split("```", 1)[0]
        )
        map_part, server_part = snippet.split(
            "# Inside the site's existing HTTPS server (certificates omitted).", 1
        )
        server_part = server_part.replace(
            "127.0.0.1:8000", f"127.0.0.1:{origin.server_port}"
        )
        if not override:
            server_part = (
                server_part.replace(
                    '    add_header Cache-Control "private, no-store, no-transform" always;\n',
                    "",
                )
                .replace("    proxy_hide_header Cache-Control;\n", "")
                .replace("    proxy_hide_header Expires;\n", "")
            )
        listen = port()
        with tempfile.TemporaryDirectory(prefix="porchsite-media-proxy-") as temp:
            base = Path(temp)
            config = base / "nginx.conf"
            config.write_text(
                f"daemon off; master_process off; pid {base}/nginx.pid; error_log {base}/error.log;\nevents {{ worker_connections 32; }}\nhttp {{ access_log off; client_body_temp_path {base}/body; proxy_temp_path {base}/proxy;\n"
                + map_part
                + f"\nserver {{ listen 127.0.0.1:{listen}; server_name example.com;\n"
                + server_part
                + "\n}\n}\n"
            )
            process = subprocess.Popen(
                [shutil.which("nginx"), "-p", temp + "/", "-c", str(config)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )

            def fetch(method="GET", headers=None):
                connection = http.client.HTTPConnection("127.0.0.1", listen, timeout=3)
                try:
                    connection.request(
                        method, "/media/fixture.jpg", headers=headers or {}
                    )
                    response = connection.getresponse()
                    return response.status, dict(response.getheaders()), response.read()
                finally:
                    connection.close()

            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read().decode())
                try:
                    with socket.create_connection(("127.0.0.1", listen), timeout=0.05):
                        break
                except OSError:
                    time.sleep(0.02)
            for _ in range(2):
                before = len(state["calls"])
                status, headers, body = fetch()
                assert status == 200 and body == BODY
                assert len(state["calls"]) == before + 1
                assert headers["Cache-Control"] == (
                    "private, no-store, no-transform"
                    if override
                    else "no-cache, no-transform"
                )
                assert headers["Strict-Transport-Security"] == "max-age=31536000"
            for method in ["GET", "HEAD"]:
                status, headers, body = fetch(method, {"If-None-Match": TAG})
                assert status == 304 and not body and headers["ETag"] == TAG
                for actor in ["owner", "reader", "authorization"]:
                    auth = (
                        {"Authorization": "Bearer fixture"}
                        if actor == "authorization"
                        else {"Cookie": f"__Host-sk_{actor}=fixture"}
                    )
                    before = len(state["calls"])
                    status, headers, body = fetch(
                        method, {**auth, "If-None-Match": TAG}
                    )
                    assert (
                        status == 200
                        and "no-store" in headers["Cache-Control"]
                        and "ETag" not in headers
                    )
                    assert body == (actor.encode() + BODY if method == "GET" else b"")
                    assert len(state["calls"]) == before + 1
                    assert state["calls"][-1][1:] == (
                        auth.get("Cookie", ""),
                        auth.get("Authorization"),
                    )
                assert fetch(method)[2] == (BODY if method == "GET" else b"")
            state["published"] = False
            for method in ["GET", "HEAD"]:
                status, _, body = fetch(method, {"If-None-Match": TAG})
                assert status == 404 and body == (
                    b"missing" if method == "GET" else b""
                )
            state["published"], state["private"] = True, True
            assert fetch(headers={"If-None-Match": "*"})[0::2] == (404, BLANK)
            state["private"], state["failure"] = False, True
            assert fetch()[0::2] == (503, b"origin unavailable")
            origin.shutdown()
            origin.server_close()
            status, _, body = fetch()
            assert (
                status == 502 and BODY not in body
            )  # No old image on connection failure.
            print(
                f"media proxy: {'interim override' if override else 'new origin policy'}: cold/warm, GET/HEAD/304, both cookies, Authorization, 404/private gate, 503/connection failure PASS"
            )
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        origin.shutdown()
        origin.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    if not shutil.which("nginx"):
        raise SystemExit("nginx is required for the disposable proxy check")
    run(True)
    run(False)
